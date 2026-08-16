"use strict";
/*
 Re:NEMA 4コマ専用API（テキスト表示バグ修正・同期なしのシンプル版）
 - 固定4シーン（空は自動スキップ）
 - 画像/動画コンテンツ、上下テキスト（常時表示・同時フェード）
 - 読み上げON/OFF、SFX、BGM（ダッキング）
 - フォームUI（/contest/4koma） + 非同期ジョブ（/api/jobs） + /api/render
 - セキュリティ: APIキー, コンテスト用トークン, CORS, レート制限, SSRF(DNS+Private IP遮断), MIME/サイズ制限
 - 重要修正:
   * textToPng の -size を "WxH" に修正（以前は "Wx" で高さ欠落 → 透明で何も描かれない）
   * 下テキストのオフセットを負値（南重力時は上へ）に修正
   * 画像シーンの映像尺 = シーン尺で生成、mux は -shortest 不使用（D秒に揃える）
 依存: ffmpeg, ffprobe, ImageMagick(convert, composite)

 起動例（テスト）:
   PUBLIC_TOKEN='abcd1234' \
   API_KEY='nemanemanema20250909nemaproject' \
   VOICEVOX_BASE='http://127.0.0.1:50021' \
   VOICEVOX_SPEED='1.0' \
   PORT=3000 node re_nema_4koma_server.js
*/

const fs = require("fs");
const path = require("path");
const util = require("util");
const child = require("child_process");
const exec = util.promisify(child.exec);
const express = require("express");
const bodyParser = require("body-parser");
const multer = require("multer");
const axios = require("axios");
const http = require("http");
const dns = require("dns");
const net = require("net");
const urlmod = require("url");

// ====== 環境設定 ======
const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, "output");
const TMP_DIR = path.join(ROOT, "temp");
const UP_DIR  = path.join(ROOT, "uploads");
ensureDir(OUT_DIR); ensureDir(TMP_DIR); ensureDir(UP_DIR);

const ENV = process.env;
const PORT = Number(ENV.PORT || 3000);
const API_KEY = ENV.API_KEY || "nemanemanema20250909nemaproject"; // 既定を指定どおり
const PUBLIC_TOKEN = ENV.PUBLIC_TOKEN || "abcd1234";             // /contest, /api/jobs/:id 用
const ALLOWED_ORIGINS = (ENV.ALLOWED_ORIGINS || "*").split(","); // CORS
const VOICEVOX_BASE = ENV.VOICEVOX_BASE || "http://127.0.0.1:50021";
const VOICEVOX_SPEED = Number(ENV.VOICEVOX_SPEED || 1.0);
const FONT_PATH = ENV.FONT_PATH || "/root/re-nema_ffcreator/fonts/NotoSansJP-Regular.ttf"; // 既定フォント
const TEXT_COLOR = ENV.TEXT_COLOR || "#ffffff";
const FAST = ENV.FAST === "1";
const MAX_UPLOAD_MB = Number(ENV.MAX_UPLOAD_MB || 50);
const MAX_QUEUE = Number(ENV.MAX_QUEUE || 50);
const CONCURRENCY = Number(ENV.CONCURRENCY || 1);

// ====== ユーティリティ ======
function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p, { recursive:true }); }
function stamp(){ const d=new Date(); const z=n=>String(n).padStart(2,"0"); return d.getFullYear()+z(d.getMonth()+1)+z(d.getDate())+"_"+z(d.getHours())+z(d.getMinutes())+z(d.getSeconds()); }
function errStr(e){ return (e && e.message) ? e.message : String(e); }
function isHttp(u){ return /^https?:\/\//i.test(String(u||"")); }
function isPrivateIp(ip){
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true;
  const parts = ip.split(".");
  if (parts.length === 4) { const a = Number(parts[0]), b = Number(parts[1]); if (a === 172 && b >= 16 && b <= 31) return true; }
  return false;
}
function parseUrl(u){ try { return new urlmod.URL(u); } catch(_){ return null; } }
function lookupHost(host){
  return new Promise((resolve)=> { dns.lookup(host, { all:true, verbatim:true }, function(err, addrs){ if (err || !addrs || !addrs.length) return resolve([]); resolve(addrs.map(function(a){ return a.address; })); }); });
}
async function assertSafeHttpUrl(u){
  if (!isHttp(u)) throw new Error("Only http/https allowed");
  const p = parseUrl(u); if (!p) throw new Error("Invalid URL");
  if (net.isIP(p.hostname)) { if (isPrivateIp(p.hostname)) throw new Error("URL points to private IP"); return true; }
  const addrs = await lookupHost(p.hostname); if (!addrs.length) throw new Error("DNS lookup failed");
  for (var i=0;i<addrs.length;i++){ if (isPrivateIp(addrs[i])) throw new Error("URL resolves to private IP"); }
  return true;
}

// 軽量レート制限
const RATE = { windowMs: 60*1000, limit: 30 };
const rateMap = new Map();
function rateLimit(req,res,next){
  try{
    const ip = (req.headers["x-forwarded-for"]||"").toString().split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const rec = rateMap.get(ip) || { t: now, n: 0 };
    if (now - rec.t > RATE.windowMs) { rec.t = now; rec.n = 0; }
    rec.n++; rateMap.set(ip, rec);
    if (rec.n > RATE.limit) return res.status(429).send("Too Many Requests");
    next();
  }catch(_){ next(); }
}

// ====== メディアヘルパ ======
async function downloadToTemp(src){
  await assertSafeHttpUrl(src);
  const base = String(src).split("?")[0];
  const ext = path.extname(base||"").toLowerCase() || ".bin";
  const out = path.join(TMP_DIR, `dl_${stamp()}${ext}`);
  const res = await axios.get(src, { responseType: "arraybuffer", timeout: FAST?8000:30000, maxContentLength: 1024*1024*200, maxRedirects: 2, validateStatus: s => (s>=200 && s<400) });
  fs.writeFileSync(out, Buffer.from(res.data));
  return out;
}
async function readMediaDurationSec(file){
  try{ const { stdout } = await exec(`ffprobe -v error -show_format -of json "${file}"`); const info = JSON.parse(stdout); const d = info && info.format && info.format.duration ? Number(info.format.duration) : 0; return Math.max(0, d); }catch(_){ return 0; }
}

// ====== テキストPNG生成（★修正） ======
async function textToPng(text, width, canvasH, fontSize, colorHex, align, outPath){
  const safe = String(text||"").replace(/"/g, '\\"');
  const gravity = align==="top" ? "north" : (align==="bottom" ? "south" : "center");
  // 南重力は正のYが下方向 → 下テキストは負のオフセットで上へ持ち上げる
  const yoff = align==="top" ? 80 : (align==="bottom" ? 40 : 0);
  const cmd = `convert -size ${width}x${canvasH} xc:none -font "${FONT_PATH}" -pointsize ${fontSize||48} -fill "${colorHex||TEXT_COLOR}" -gravity ${gravity} -annotate +0+${yoff} "${safe}" "${outPath}"`;
  try{ await exec(cmd); }catch(e){ console.error("[textToPng] convert failed:", cmd, errStr(e)); throw new Error("ImageMagick convert failed. Check FONT_PATH."); }
  return outPath;
}

// ====== VOICEVOX ======
async function synthVoicevoxWav(text, speakerId, outPath){
  if (!text){ await exec(`ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=stereo -t 0.1 "${outPath}"`); return outPath; }
  try{
    const q = await axios.post(VOICEVOX_BASE + "/audio_query", null, { params:{ text:String(text), speaker:speakerId }, timeout:15000 });
    try{ if (VOICEVOX_SPEED && VOICEVOX_SPEED!==1) q.data.speedScale = VOICEVOX_SPEED; }catch(_){ }
    const s = await axios.post(VOICEVOX_BASE + "/synthesis", q.data, { params:{ speaker:speakerId }, responseType:"arraybuffer", timeout:60000 });
    fs.writeFileSync(outPath, Buffer.from(s.data)); return outPath;
  }catch(e){ console.error("[VOICEVOX] fallback silence:", errStr(e)); await exec(`ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=stereo -t 0.5 "${outPath}"`); return outPath; }
}
async function concatWavsSequential(outPath, inputs){
  const norm=[]; for (var i=0;i<inputs.length;i++){ if(!inputs[i]) continue; const n=path.join(TMP_DIR,`norm_${i}_${stamp()}.wav`); await exec(`ffmpeg -y -i "${inputs[i]}" -ar 48000 -ac 2 -f wav "${n}"`); norm.push(n); }
  if(!norm.length){ await exec(`ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=stereo -t 0.1 "${outPath}"`); return outPath; }
  const list=path.join(TMP_DIR,`wavlist_${stamp()}.txt`); fs.writeFileSync(list, norm.map(function(p){return `file '${p.replace(/'/g,"'\\''")}'`;}).join("\n"),"utf8");
  await exec(`ffmpeg -y -safe 0 -f concat -i "${list}" -c copy "${outPath}"`); return outPath;
}
async function mixSfxOverVoice(outPath, voiceWav, sfxPathOrUrl, volume){
  if (!sfxPathOrUrl){ fs.copyFileSync(voiceWav, outPath); return outPath; }
  const sfx = isHttp(sfxPathOrUrl) ? await downloadToTemp(sfxPathOrUrl) : sfxPathOrUrl;
  const vol = (typeof volume === "number") ? volume : 1.0;
  const cmd = `ffmpeg -y -i "${voiceWav}" -i "${sfx}" -filter_complex "[1:a]volume=${vol}[s];[0:a][s]amix=inputs=2:duration=first:dropout_transition=3[a]" -map "[a]" -c:a aac "${outPath}"`;
  await exec(cmd); return outPath;
}

// ====== 画像ベース（テキストはここで合成して映像化） ======
async function composeCanvasPng(W,H,bgColor,bgImage,overlayAlpha,contentUrl,fit,topText,bottomText){
  const canvas=path.join(TMP_DIR,`canvas_${stamp()}.png`);
  await exec(`convert -size ${W}x${H} xc:"${bgColor||"#212121"}" "${canvas}"`);
  if (bgImage){
    const bgLocal = isHttp(bgImage)? await downloadToTemp(bgImage) : bgImage;
    const bgFit = path.join(TMP_DIR,`bgfit_${stamp()}.png`);
    await exec(`convert "${bgLocal}" -resize ${W}x${H}^ -gravity center -extent ${W}x${H} "${bgFit}"`);
    await exec(`composite -gravity center "${bgFit}" "${canvas}" "${canvas}"`);
    if (typeof overlayAlpha==='number' && overlayAlpha>0){
      const percent = Math.min(100, Math.max(0, Math.round(overlayAlpha*100)));
      await exec(`convert "${canvas}" -fill "${bgColor||"#212121"}" -colorize ${percent} "${canvas}"`);
    }
  }
  if (contentUrl){
    const imgLocal = isHttp(contentUrl)? await downloadToTemp(contentUrl) : contentUrl;
    const fitted = path.join(TMP_DIR,`imgfit_${stamp()}.png`);
    if ((fit||"contain")==="cover"){ await exec(`convert "${imgLocal}" -resize ${W}x${H}^ -gravity center -extent ${W}x${H} "${fitted}"`); }
    else { await exec(`convert "${imgLocal}" -resize ${W}x${H} -background none -gravity center -extent ${W}x${H} "${fitted}"`); }
    await exec(`composite -gravity center "${fitted}" "${canvas}" "${canvas}"`);
  }
  const boxH = Math.max(120, Math.floor(H*0.22));
  if (topText && topText.text){
    const tpng=path.join(TMP_DIR,`ttop_${stamp()}.png`); await textToPng(topText.text,W,boxH,48,TEXT_COLOR,"top",tpng);
    await exec(`composite -gravity north "${tpng}" "${canvas}" "${canvas}"`);
  }
  if (bottomText && bottomText.text){
    const bpng=path.join(TMP_DIR,`tbot_${stamp()}.png`); await textToPng(bottomText.text,W,boxH,48,TEXT_COLOR,"bottom",bpng);
    await exec(`composite -gravity south "${bpng}" "${canvas}" "${canvas}"`);
  }
  return canvas;
}
async function renderImageSilent(outMp4, W,H,FPS, scene, duration){
  const bgc = (scene.background && scene.background.color) || "#212121";
  const bgi = scene.background && scene.background.imageUrl;
  const alp = (scene.background && typeof scene.background.overlayAlpha==='number') ? Number(scene.background.overlayAlpha) : 0;
  const contentUrl = scene.content && scene.content.url;
  const fit = (scene.content && scene.content.fit) || 'contain';
  const canvas = await composeCanvasPng(W,H,bgc,bgi,alp,contentUrl,fit,scene.topText, scene.bottomText);
  const D = Math.max(1, Math.floor(duration||5));
  await exec(`ffmpeg -y -loop 1 -i "${canvas}" -t ${D} -r ${FPS} -vf "format=yuv420p" -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.1 "${outMp4}"`);
  return outMp4;
}

// ====== 動画ベース（テキストは全尺ループで常時表示） ======
async function renderVideoSilent(outMp4, W,H,FPS, scene, duration){
  const vsrc = scene.content && scene.content.url; const fit = (scene.content && scene.content.fit) || 'contain';
  const vLocal = isHttp(vsrc)? await downloadToTemp(vsrc) : vsrc;
  const vf = fit==="cover"
    ? `scale=w=${W}:h=${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
    : `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;

  const D = Math.max(1, Math.floor(duration||5));
  const boxH = Math.max(120, Math.floor(H*0.22));
  const inputs=[`-i "${vLocal}"`]; var idx=0; var filter=`[0:v]${vf}[v0]`; var last='[v0]';
  if (scene.topText && scene.topText.text){
    const tpng=path.join(TMP_DIR,`ttop_${stamp()}.png`); await textToPng(scene.topText.text,W,boxH,48,TEXT_COLOR,"top",tpng);
    inputs.push(`-loop 1 -t ${D} -i "${tpng}"`); idx++;
    filter+=`;${last}[${idx}:v]overlay=x=(W-w)/2:y=40:format=auto[v${idx}]`.replace(/W/g,String(W)).replace(/H/g,String(H));
    last=`[v${idx}]`;
  }
  if (scene.bottomText && scene.bottomText.text){
    const bpng=path.join(TMP_DIR,`tbot_${stamp()}.png`); await textToPng(scene.bottomText.text,W,boxH,48,TEXT_COLOR,"bottom",bpng);
    inputs.push(`-loop 1 -t ${D} -i "${bpng}"`); idx++;
    filter+=`;${last}[${idx}:v]overlay=x=(W-w)/2:y=H-h-40:format=auto[v${idx}]`.replace(/W/g,String(W)).replace(/H/g,String(H));
    last=`[v${idx}]`;
  }
  const fin = (scene.content && scene.content.effect && scene.content.effect.in) ? Number(scene.content.effect.in) : 0.6;
  const fout= (scene.content && scene.content.effect && scene.content.effect.out)? Number(scene.content.effect.out): 0.6;
  filter += `;${last}fade=t=in:st=0:d=${fin},fade=t=out:st=${Math.max(0,D-fout)}:d=${fout}[vout]`;
  const cmd = `ffmpeg -y ${inputs.join(' ')} -filter_complex "${filter}" -map "[vout]" -an -r ${FPS} -pix_fmt yuv420p -c:v libx264 -profile:v baseline -level 3.1 -t ${D} "${outMp4}"`;
  await exec(cmd); return outMp4;
}

// ====== シーン音声 → mux → 連結 ======
async function buildSceneAudio(scene, speakerDefault){
  const topT = scene.topText && scene.topText.text ? String(scene.topText.text) : "";
  const botT = scene.bottomText && scene.bottomText.text ? String(scene.bottomText.text) : "";
  const spTop = scene.topText && !!scene.topText.speak;
  const spBot = scene.bottomText && !!scene.bottomText.speak;
  const spkTop = (scene.topText && scene.topText.speakerId) ? Number(scene.topText.speakerId) : speakerDefault;
  const spkBot = (scene.bottomText && scene.bottomText.speakerId) ? Number(scene.bottomText.speakerId) : speakerDefault;
  const minD = (typeof scene.durationMin === "number") ? Number(scene.durationMin) : 5;

  const wavs = [];
  if (spTop) { const f = path.join(TMP_DIR, `top_${stamp()}.wav`); await synthVoicevoxWav(topT, spkTop, f); wavs.push(f); }
  if (spBot) { const f = path.join(TMP_DIR, `bot_${stamp()}.wav`); await synthVoicevoxWav(botT, spkBot, f); wavs.push(f); }

  var voice = path.join(TMP_DIR, `voice_${stamp()}.wav`);
  if (wavs.length === 0) {
    await exec(`ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=stereo -t ${minD} "${voice}"`);
  } else {
    await concatWavsSequential(voice, wavs);
    const d = await readMediaDurationSec(voice);
    if (d < minD - 0.05) {
      const v2 = path.join(TMP_DIR, `voice_pad_${stamp()}.wav`);
      await exec(`ffmpeg -y -i "${voice}" -f lavfi -t ${minD} -i anullsrc=r=48000:cl=stereo -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[a]" -map "[a]" "${v2}"`);
      voice = v2;
    } else {
      const nrm = path.join(TMP_DIR, `voice_norm_${stamp()}.wav`);
      await exec(`ffmpeg -y -i "${voice}" -ar 48000 -ac 2 -f wav "${nrm}"`);
      voice = nrm;
    }
  }

  const sfxUrl = scene.sfx && scene.sfx.url ? scene.sfx.url : "";
  const sfxVol = scene.sfx && typeof scene.sfx.volume === "number" ? Number(scene.sfx.volume) : undefined;
  const prog = path.join(TMP_DIR, `sceneprog_${stamp()}.m4a`);
  await mixSfxOverVoice(prog, voice, sfxUrl, sfxVol);

  const voiceDur = await readMediaDurationSec(voice);
  const finalDur = Math.max(minD, Math.ceil(voiceDur + 0.25));
  return { audio: prog, duration: finalDur };
}
async function muxVideoAudio(outMp4, silentMp4, audioPath, duration, effect){
  const fin = (effect && effect.in) ? Number(effect.in) : 0.5;
  const fout= (effect && effect.out)? Number(effect.out) : 0.5;
  const D = Math.max(1, Math.floor(duration||5));
  const cmd = `ffmpeg -y -stream_loop -1 -i "${silentMp4}" -i "${audioPath}" -t ${D} -vf "fade=t=in:st=0:d=${fin},fade=t=out:st=${Math.max(0,D-fout)}:d=${fout}" -c:v libx264 -pix_fmt yuv420p -c:a aac "${outMp4}"`;
  await exec(cmd); return outMp4;
}
async function concatVideos(files, finalOut){
  const list=path.join(TMP_DIR,`list_${stamp()}.txt`);
  fs.writeFileSync(list, files.map(function(f){ return `file '${f.replace(/'/g,"'\\''")}'`; }).join("\n"), "utf8");
  await exec(`ffmpeg -y -safe 0 -f concat -i "${list}" -c:v libx264 -preset veryfast -crf 22 -c:a aac -ar 48000 "${finalOut}"`);
  return finalOut;
}
async function addBgm(finalIn, bgm){
  if (!bgm || bgm.mode==="none") return finalIn;
  const url = (bgm.mode==="url" ? (bgm.url||"") : ""); if (!url) return finalIn;
  const out = finalIn.replace(/\.mp4$/i, "_bgm.mp4");
  const vol = (typeof bgm.volume==='number') ? bgm.volume : 0.15;
  const loop = (typeof bgm.loop==='boolean') ? bgm.loop : true; const loopOpt = loop ? "-stream_loop -1" : "";
  const duck = !!bgm.duck;
  const duckCmd = `ffmpeg -y -i "${finalIn}" ${loopOpt} -i "${url}" -filter_complex "[1:a]volume=${vol}[bg];[bg][0:a]sidechaincompress=threshold=0.015:ratio=12:attack=5:release=1200[duck];[0:a][duck]amix=inputs=2:duration=first:dropout_transition=3[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${out}"`;
  const mixCmd = `ffmpeg -y -i "${finalIn}" ${loopOpt} -i "${url}" -filter_complex "[1:a]volume=${vol}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=3[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${out}"`;
  try{ await exec(duck ? duckCmd : mixCmd); }catch(e){ if(duck){ await exec(mixCmd); } else { throw e; } }
  return out;
}

// ====== v1 互換の正規化 ======
function normalizeV1(body){
  if (body && body.scenes) return body;
  const max = 4; const scenes=[];
  for (var i=1;i<=max;i++){
    var t = body["text_"+i] || "";
    var img = body["image_"+i] || "";
    var md = body["minDuration_"+i] ? Number(body["minDuration_"+i]) : undefined;
    if (!t && !img) continue;
    scenes.push({ durationMin: md, background: {}, content: img ? { type:"image", url:img, fit:"contain", effect:{ name:"fade" } } : undefined, topText: t ? { text:t, speak:true, effect:{ name:"fade" } } : undefined });
  }
  return { meta: { title: body.title||"", description: body.description||"" }, video: { width: Number(body.width||720), height: Number(body.height||1280), fps: Number(body.fps||25), bgColorDefault: body.bgColorDefault||"#212121" }, voice: { engine: "voicevox", speakerId: Number(body.speakerId||2) }, bgm: (body.bgm_url ? { mode:"url", url: body.bgm_url, volume: Number(body.bgm_volume||0.15), duck: !!body.bgm_duck, loop:true } : { mode:"none" }), scenes: scenes };
}

// ====== レンダリング本体 ======
async function renderFromConfig(cfg){
  const W = cfg.video && cfg.video.width ? Number(cfg.video.width) : 720;
  const H = cfg.video && cfg.video.height ? Number(cfg.video.height) : 1280;
  const FPS = cfg.video && cfg.video.fps ? Number(cfg.video.fps) : 25;
  const bgDefault = (cfg.video && cfg.video.bgColorDefault) || "#212121";
  const spk = (cfg.voice && cfg.voice.speakerId) ? Number(cfg.voice.speakerId) : 2;

  const outs=[]; const scenes = cfg.scenes || [];
  for (var i=0;i<scenes.length && i<4;i++){
    const sc = scenes[i];
    const part = await buildSceneAudio(sc, spk);
    const D = Math.max(1, Math.floor(part.duration||5));

    if (!sc.background) sc.background = { color: bgDefault };
    if (!sc.background.color) sc.background.color = bgDefault;

    const base = path.join(TMP_DIR,`base_${i+1}_${stamp()}.mp4`);
    if (sc.content && sc.content.type==='video' && sc.content.url){ await renderVideoSilent(base, W,H,FPS, sc, D); }
    else { await renderImageSilent(base, W,H,FPS, sc, D); }

    const withAudio = path.join(TMP_DIR,`scene_${i+1}_${stamp()}.mp4`);
    const eff = (sc.content && sc.content.effect) ? sc.content.effect : {name:'fade'};
    await muxVideoAudio(withAudio, base, part.audio, D, eff);
    outs.push(withAudio);
  }

  const finalOut = path.join(OUT_DIR, `video_${stamp()}.mp4`);
  const list=path.join(TMP_DIR,`list_${stamp()}.txt`);
  fs.writeFileSync(list, outs.map(function(f){ return `file '${f.replace(/'/g,"'\\''")}'`; }).join("\n"),"utf8");
  await exec(`ffmpeg -y -safe 0 -f concat -i "${list}" -c:v libx264 -preset veryfast -crf 22 -c:a aac -ar 48000 "${finalOut}"`);

  const withBgm = await addBgm(finalOut, cfg.bgm||{mode:'none'});
  return withBgm;
}

// ====== Express サーバ ======
const app = express();
app.use(function(req,res,next){
  const origin = (req.headers.origin||"*").toString();
  const allow = (ALLOWED_ORIGINS.indexOf("*")>=0) || (ALLOWED_ORIGINS.indexOf(origin)>=0);
  if (allow) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, x-api-key");
  res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");
  if (req.method==="OPTIONS"){ res.status(204).end(); } else next();
});
function auth(req,res,next){ if (!API_KEY) return next(); const k = (req.headers["x-api-key"]||"").toString(); if (k === API_KEY) return next(); return res.status(401).json({ ok:false, error:"unauthorized" }); }
function contestGuard(req,res,next){ if (!PUBLIC_TOKEN) return next(); const t = ((req.query && req.query.token) || (req.body && req.body.token) || "").toString(); if (t === PUBLIC_TOKEN) return next(); return res.status(401).send("contest token required"); }
app.use(rateLimit);

// 出力
app.get("/output/:file", function(req,res){ const file = path.basename(req.params.file || ""); const p = path.join(OUT_DIR, file); if (!p.startsWith(OUT_DIR)) return res.status(400).send("bad path"); if (!fs.existsSync(p)) return res.status(404).send("not found"); res.sendFile(p); });

// ヘルス
app.get("/health", async function(req,res){ let ff=false, im=false; try{ await exec("ffmpeg -version"); ff=true; }catch(_){ } try{ await exec("convert -version"); im=true; }catch(_){ } res.json({ ok:true, port:PORT, outDir:OUT_DIR, tmpDir:TMP_DIR, ffmpeg:ff, imagemagick:im, voicevox: VOICEVOX_BASE, font: FONT_PATH }); });

// ---- フォームUI ----
const storage = multer.diskStorage({ destination: function(req,file,cb){ cb(null, UP_DIR); }, filename: function(req,file,cb){ cb(null, Date.now()+"_"+file.originalname.replace(/[^\w.\-]/g,"_")); } });
const fileFilter = function(req,file,cb){ const ok = /^image\/(png|jpe?g|webp)$|^video\/(mp4|quicktime)$|^audio\/(mpeg|mp3|wav|aac)$/.test(file.mimetype); cb(ok?null:new Error("unsupported file type"), ok); };
const upload = multer({ storage, fileFilter, limits:{ fileSize: MAX_UPLOAD_MB*1024*1024 } });

app.get("/contest/4koma", contestGuard, function(req,res){
  res.set("Content-Type","text/html; charset=utf-8");
  res.send(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>4コマ動画グランプリ</title>
<style>body{font-family:sans-serif;max-width:880px;margin:24px auto;padding:0 12px}fieldset{margin:16px 0}.row{border:1px solid #ddd;padding:12px;margin:10px 0}</style>
<h1>4コマ動画グランプリ（テスト）</h1>
<form method="POST" action="/contest/4koma${PUBLIC_TOKEN?('?token='+PUBLIC_TOKEN):''}" enctype="multipart/form-data">
<input type="hidden" name="token" value="${PUBLIC_TOKEN}">
<fieldset><legend>全体設定</legend>
タイトル <input name="title" style="width:60%"><br>
説明 <br><textarea name="description" rows="2" style="width:100%"></textarea><br>
サイズ <input name="width" value="720" size="4"> x <input name="height" value="1280" size="4"> @ <input name="fps" value="25" size="3">fps<br>
背景色(既定) <input name="bgColorDefault" value="#212121"><br>
VOICEVOX speakerId <input name="speakerId" value="2" size="3"><br>
BGM URL <input name="bgm_url" style="width:60%"> 音量 <input name="bgm_volume" value="0.15" size="4"> ダッキング <input type="checkbox" name="bgm_duck" checked>
</fieldset>
${[1,2,3,4].map(function(i){return `
<div class="row">
  <h3>シーン${i}</h3>
  最低秒数 <input name="minDuration_${i}" value="5" size="3"><br>
  背景色 <input name="bgColor_${i}"> 背景画像 <input type="file" name="bgImage_${i}" accept="image/*"><br>
  コンテンツ <input type="file" name="content_${i}" accept="image/*,video/mp4,video/quicktime"> or URL <input name="contentUrl_${i}" style="width:50%"> 効果 <select name="contentFx_${i}"><option>fade</option></select><br>
  上部テキスト <input name="top_${i}" style="width:60%"> 読み上げ <input type="checkbox" name="speak_top_${i}" checked><br>
  下部テキスト <input name="bottom_${i}" style="width:60%"> 読み上げ <input type="checkbox" name="speak_bottom_${i}"><br>
  SFX <input type="file" name="sfx_${i}" accept="audio/*"> 音量 <input name="sfxVolume_${i}" value="1.0" size="4">
</div>`}).join("")}
<button type="submit">送信（生成をキューに追加）</button>
</form>`);
});

app.post("/contest/4koma", contestGuard, upload.any(), async function(req,res){
  try{
    const F={}; (req.files||[]).forEach(function(f){ F[f.fieldname]=f.path; });
    const B=req.body||{}; const scenes=[];
    for (var i=1;i<=4;i++){
      var top=B['top_'+i]||''; var bottom=B['bottom_'+i]||'';
      var md = B['minDuration_'+i] ? Number(B['minDuration_'+i]) : undefined;
      var bgc=B['bgColor_'+i]||''; var bgi=F['bgImage_'+i]||'';
      var cfile=F['content_'+i]||''; var curl=B['contentUrl_'+i]||''; var src=cfile||curl;
      var ctype = src && /\.(mp4|mov)$/i.test(src) ? 'video' : (src? 'image' : '');
      var sfx=F['sfx_'+i]||''; var sfxVol=B['sfxVolume_'+i] ? Number(B['sfxVolume_'+i]) : 1.0;
      if (!top && !bottom && !src && !bgi) continue;
      scenes.push({ durationMin: md, background: { color:bgc||undefined, imageUrl:bgi||undefined, overlayAlpha: bgi?0.35:undefined }, content: src? { type:ctype||'image', url:src, fit:'contain', effect:{name:B['contentFx_'+i]||'fade'} } : undefined, topText: top? { text:top, speak: !!B['speak_top_'+i], effect:{name:'fade'} } : undefined, bottomText: bottom? { text:bottom, speak: !!B['speak_bottom_'+i], effect:{name:'fade'} } : undefined, sfx: sfx? { url:sfx, volume:sfxVol } : undefined });
    }
    const cfg={ meta:{ title:B.title||'', description:B.description||'' }, video:{ width:Number(B.width||720), height:Number(B.height||1280), fps:Number(B.fps||25), bgColorDefault:B.bgColorDefault||'#212121' }, voice:{ engine:'voicevox', speakerId:Number(B.speakerId||2) }, bgm: (B.bgm_url? { mode:'url', url:B.bgm_url, volume:Number(B.bgm_volume||0.15), duck: !!B.bgm_duck, loop:true } : { mode:'none' }), scenes: scenes };

    const id = enqueue(cfg);
    res.set("Content-Type","text/html; charset=utf-8");
    res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>受付完了</title>
      <h2>受付しました</h2><p>ジョブID: <code>${id}</code></p>
      <div id="st">処理待ち...</div>
      <script>
        async function poll(){
          try{
            const r = await fetch('/api/jobs/${id}${PUBLIC_TOKEN?('?token='+PUBLIC_TOKEN):''}');
            const j = await r.json();
            if(!j.ok){ document.getElementById('st').textContent='エラー: '+(j.error||'unknown'); return; }
            if(j.status==='done'){ document.getElementById('st').innerHTML = '完了: <a href="'+ j.result.url +'">ダウンロード/再生</a>'; return; }
            if(j.status==='error'){ document.getElementById('st').textContent='失敗: '+(j.error||'unknown'); return; }
            document.getElementById('st').textContent = (j.status||'')+'...'; setTimeout(poll, 4000);
          }catch(e){ document.getElementById('st').textContent='通信エラー'; setTimeout(poll, 5000); }
        }
        poll();
      </script>`);
  }catch(e){ res.status(400).send(String(e && e.message || e)); }
});

// ---- ジョブAPI ----
app.post("/api/jobs", auth, bodyParser.json({limit:"10mb"}), function(req,res){
  try{ if (q.length + runningCount >= MAX_QUEUE) return res.status(429).json({ ok:false, error:"queue full" }); const id = enqueue(req.body||{}); res.json({ ok:true, jobId:id }); }catch(e){ res.status(400).json({ ok:false, error: errStr(e) }); }
});
app.get("/api/jobs/:id", function(req,res){
  if (API_KEY) {
    const k = (req.headers["x-api-key"]||"").toString();
    const t = ((req.query && req.query.token) || "").toString();
    if (k !== API_KEY && !(PUBLIC_TOKEN && t === PUBLIC_TOKEN)) { return res.status(401).json({ ok:false, error:"unauthorized" }); }
  }
  const j = jobs.get(req.params.id); if (!j) return res.status(404).json({ ok:false, error:"not found" });
  res.json({ ok:true, status:j.status, result:j.result, error:j.error });
});

// 後方互換（同期）
app.post("/api/render", auth, bodyParser.json({limit:"10mb"}), bodyParser.urlencoded({ extended:true, limit:"10mb" }), async function(req,res){
  try{ const cfg = normalizeV1(req.body||{}); const out = await renderFromConfig(cfg); const file = path.basename(out); res.json({ ok:true, file:file, url:"/output/"+file }); }catch(e){ res.status(400).json({ ok:false, error: errStr(e) }); }
});

// ====== ジョブキュー ======
const q=[]; var runningCount=0; const jobs=new Map();
function enqueue(payload){ const cfg = payload && payload.scenes ? payload : normalizeV1(payload||{}); const id = Date.now().toString(36) + Math.random().toString(36).slice(2,8); jobs.set(id, { status:"queued", payload: cfg }); q.push(id); pump(); return id; }
async function workerOnce(id){ const j=jobs.get(id); if (!j) return; j.status="working"; try{ const out = await renderFromConfig(j.payload); const file = path.basename(out); j.status="done"; j.result={ file, url:"/output/"+file }; }catch(e){ j.status="error"; j.error=errStr(e); } }
async function pump(){ if (runningCount>=CONCURRENCY || q.length===0) return; const id=q.shift(); runningCount++; workerOnce(id).then(function(){ runningCount--; setImmediate(pump); }).catch(function(){ runningCount--; setImmediate(pump); }); }

// ====== 起動 ======
const appServer = http.createServer(app);
appServer.listen(PORT, function(){ console.log("4koma server listening on :"+PORT); });
