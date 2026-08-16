"use strict";
/*
 Re:NEMA 4コマAPI（外部公開用 LITE フォーム付き / 改良版）
 - 4シーン（空は自動スキップ）
 - 画像/動画コンテンツ、上下テキスト（同時表示）
 - 読み上げON/OFF、シーンSFX（/root/re-nema_ffcreator/sounds/sfx 参照・プレビュー）、全体BGM（/root/re-nema_ffcreator/sounds/bgm 参照・プレビュー）
 - 効果は fade 固定（UI非表示）
 - 最低時間は 5 秒固定（UI非表示）
 - 背景色は全体のみ（カラーピッカー）
 - 元動画の音声は「OFF のときチェック」（UI修正）
 - フォームのチェックボックス整列（浮き/サイズ崩れ対策）
 - 音ズレ対策：各シーンの音声は D 秒で厳密トリム＆-shortest、SFXも声尺に合わせてトリム
 - VOICEVOX スピーカー一覧を参照可能（/api/voicevox/speakers 経由）
 - テキスト自動改行（ImageMagick caption:）＋文字数に応じた簡易フォント自動縮小
 - セキュリティ: APIキー, contest token, CORS, レート制限, SSRF(DNS+Private IP遮断), MIME/サイズ制限
 - 依存: ffmpeg, ffprobe, ImageMagick(convert, composite)

 起動例:
   PUBLIC_TOKEN='abcd1234' \
   API_KEY='nemanemanema20250909nemaproject' \
   VOICEVOX_BASE='http://127.0.0.1:50021' \
   VOICEVOX_SPEED='1.0' \
   FONT_PATH='/root/re-nema_ffcreator/fonts/NotoSansJP-Regular.ttf' \
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
const SFX_DIR = "/root/re-nema_ffcreator/sounds/sfx"; // 小文字（確定）
const BGM_DIR = "/root/re-nema_ffcreator/sounds/bgm"; // 小文字（確定）
ensureDir(OUT_DIR); ensureDir(TMP_DIR); ensureDir(UP_DIR);
ensureDir(SFX_DIR); ensureDir(BGM_DIR);

const ENV = process.env;
const PORT = Number(ENV.PORT || 3000);
const API_KEY = ENV.API_KEY || "nemanemanema20250909nemaproject"; // 既定
const PUBLIC_TOKEN = ENV.PUBLIC_TOKEN || "abcd1234";             // /contest, /api/jobs/:id 用
const ALLOWED_ORIGINS = (ENV.ALLOWED_ORIGINS || "*").split(","); // CORS
const VOICEVOX_BASE = ENV.VOICEVOX_BASE || "http://127.0.0.1:50021";
const VOICEVOX_SPEED = Number(ENV.VOICEVOX_SPEED || 1.0);
const FONT_PATH = ENV.FONT_PATH || "/root/re-nema_ffcreator/fonts/NotoSansJP-Regular.ttf";
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
function isPrivateIp(ip){ if (!ip) return true; if (ip === "127.0.0.1" || ip === "::1") return true; if (ip.startsWith("10.")) return true; if (ip.startsWith("192.168.")) return true; if (ip.startsWith("169.254.")) return true; const parts = ip.split("."); if (parts.length === 4) { const a = Number(parts[0]), b = Number(parts[1]); if (a === 172 && b >= 16 && b <= 31) return true; } return false; }
function parseUrl(u){ try { return new urlmod.URL(u); } catch(_){ return null; } }
function lookupHost(host){ return new Promise((resolve)=> { dns.lookup(host, { all:true, verbatim:true }, function(err, addrs){ if (err || !addrs || !addrs.length) return resolve([]); resolve(addrs.map(function(a){ return a.address; })); }); }); }
async function assertSafeHttpUrl(u){ if (!isHttp(u)) throw new Error("Only http/https allowed"); const p = parseUrl(u); if (!p) throw new Error("Invalid URL"); if (net.isIP(p.hostname)) { if (isPrivateIp(p.hostname)) throw new Error("URL points to private IP"); return true; } const addrs = await lookupHost(p.hostname); if (!addrs.length) throw new Error("DNS lookup failed"); for (var i=0;i<addrs.length;i++){ if (isPrivateIp(addrs[i])) throw new Error("URL resolves to private IP"); } return true; }
function safeJoin(baseDir, name){ const p = path.normalize(path.join(baseDir, name)); if (!p.startsWith(baseDir)) throw new Error("bad filename"); return p; }

// 軽量レート制限
const RATE = { windowMs: 60*1000, limit: 30 };
const rateMap = new Map();
function rateLimit(req,res,next){ try{ const ip = (req.headers["x-forwarded-for"]||"").toString().split(",")[0].trim() || req.socket.remoteAddress || "unknown"; const now = Date.now(); const rec = rateMap.get(ip) || { t: now, n: 0 }; if (now - rec.t > RATE.windowMs) { rec.t = now; rec.n = 0; } rec.n++; rateMap.set(ip, rec); if (rec.n > RATE.limit) return res.status(429).send("Too Many Requests"); next(); }catch(_){ next(); } }

// ====== メディアヘルパ ======
async function downloadToTemp(src){ await assertSafeHttpUrl(src); const base = String(src).split("?")[0]; const ext = path.extname(base||"").toLowerCase() || ".bin"; const out = path.join(TMP_DIR, `dl_${stamp()}${ext}`); const res = await axios.get(src, { responseType: "arraybuffer", timeout: FAST?8000:30000, maxContentLength: 1024*1024*200, maxRedirects: 2, validateStatus: s => (s>=200 && s<400) }); fs.writeFileSync(out, Buffer.from(res.data)); return out; }
async function readMediaDurationSec(file){ try{ const { stdout } = await exec(`ffprobe -v error -show_format -of json "${file}"`); const info = JSON.parse(stdout); const d = info && info.format && info.format.duration ? Number(info.format.duration) : 0; return Math.max(0, d); }catch(_){ return 0; } }

// ====== テキストPNG（自動改行＋簡易自動縮小） ======
function guessPointSize(text, W){ const n = (String(text||"").length); if (W >= 900) { if (n>90) return 28; if (n>60) return 36; if (n>40) return 42; if (n>28) return 48; return 56; } else { if (n>90) return 24; if (n>60) return 30; if (n>40) return 36; if (n>28) return 42; return 50; } }
async function textToPngAuto(text, width, canvasH, colorHex, align, outPath){
  const safe = String(text||"").replace(/"/g, '\\"');
  const gravity = align==="top" ? "north" : (align==="bottom" ? "south" : "center");
  const ps = guessPointSize(safe, width);
  // caption: は自動改行。フォントは環境変数で固定。
  const cmd = `convert -background none -fill "${colorHex||TEXT_COLOR}" -font "${FONT_PATH}" -pointsize ${ps} -size ${width}x${canvasH} -gravity ${gravity} caption:"${safe}" "${outPath}"`;
  try{ await exec(cmd); }catch(e){ console.error("[textToPngAuto]", cmd, errStr(e)); throw new Error("ImageMagick convert(caption:) failed"); }
  return outPath;
}

// ====== VOICEVOX ======
// KEEP / use this version
async function synthVoicevoxWav(text, speakerId, outPath){
  if (!text){
    await exec(`ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=stereo -t 0.1 "${outPath}"`);
    return outPath;
  }
  try{
    const q = await axios.post(VOICEVOX_BASE + "/audio_query", null,
      { params:{ text:String(text), speaker:speakerId }, timeout:15000 });
    try{
      if (VOICEVOX_SPEED && VOICEVOX_SPEED!==1) q.data.speedScale = VOICEVOX_SPEED;
      if (typeof VOICEVOX_PAUSE === 'number' && !Number.isNaN(VOICEVOX_PAUSE))
        q.data.pauseLengthScale = VOICEVOX_PAUSE;
    }catch(_){}
    const s = await axios.post(VOICEVOX_BASE + "/synthesis", q.data,
      { params:{ speaker:speakerId }, responseType:"arraybuffer", timeout:60000 });
    const tmp = outPath + ".raw.wav";
    fs.writeFileSync(tmp, Buffer.from(s.data));
    // ★末尾は切らない。先頭だけ軽く整える
    await exec(
      `ffmpeg -y -i "${tmp}" ` +
      `-af "silenceremove=start_periods=1:start_silence=0.25:start_threshold=-40dB" ` +
      `-ar 48000 -ac 2 -f wav "${outPath}"`
    );
    try{ fs.unlinkSync(tmp); }catch(_){}
    return outPath;
  }catch(e){
    console.error("[VOICEVOX] fallback silence:", errStr(e));
    await exec(`ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=stereo -t 0.5 "${outPath}"`);
    return outPath;
  }
}


async function concatWavsSequential(outPath, inputs){
  const norm=[];
  for (var i=0;i<inputs.length;i++){
    if(!inputs[i]) continue;
    const n=path.join(TMP_DIR,`norm_${i}_${stamp()}.wav`);
    await exec(`ffmpeg -y -i "${inputs[i]}" -ar 48000 -ac 2 -f wav "${n}"`);
    norm.push(n);
  }
  if(!norm.length){ await exec(`ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=stereo -t 0.15 "${outPath}"`); return outPath; }
  const list=path.join(TMP_DIR,`wavlist_${stamp()}.txt`);
  fs.writeFileSync(list, norm.map(function(p){return `file '${p.replace(/'/g,"'\\''")}'`;}).join("\n"),"utf8");
  await exec(`ffmpeg -y -safe 0 -f concat -i "${list}" -c copy "${outPath}"`);
  return outPath;
}

// SFXを音声に重ねる（声の長さに厳密合わせ / 次シーンへはみ出さない）
async function mixSfxOverVoice(outPath, voiceWav, sfxObj){
  if (!sfxObj){ fs.copyFileSync(voiceWav, outPath); return outPath; }
  const vol = (typeof sfxObj.volume === "number") ? sfxObj.volume : 1.0;
  let sfxPath = "";
  if (sfxObj.fsPath && fs.existsSync(sfxObj.fsPath)) sfxPath = sfxObj.fsPath;
  else if (sfxObj.url && isHttp(sfxObj.url)) sfxPath = await downloadToTemp(sfxObj.url);
  else { fs.copyFileSync(voiceWav, outPath); return outPath; }

  const D = Math.max(0.1, await readMediaDurationSec(voiceWav));
  const filter = `[0:a]atrim=end=${D},asetpts=PTS-STARTPTS[v];`+
                 `[1:a]volume=${vol},atrim=end=${D},asetpts=PTS-STARTPTS[s];`+
                 `[v][s]amix=inputs=2:duration=shortest[a]`;
  const cmd = `ffmpeg -y -i "${voiceWav}" -i "${sfxPath}" -filter_complex "${filter}" -map "[a]" -ar 48000 -c:a aac -shortest -t ${D} "${outPath}"`;
  await exec(cmd);
  return outPath;
}

// ====== 画像シーン（上下文字を事前合成） ======
async function composeCanvasPng(W,H,bgColor,contentUrl,fit,topText,bottomText){
  const canvas=path.join(TMP_DIR,`canvas_${stamp()}.png`);
  await exec(`convert -size ${W}x${H} xc:"${bgColor||"#212121"}" "${canvas}"`);
  if (contentUrl){
    const imgLocal = isHttp(contentUrl)? await downloadToTemp(contentUrl) : contentUrl;
    const fitted = path.join(TMP_DIR,`imgfit_${stamp()}.png`);
    if ((fit||"contain")==="cover"){
      await exec(`convert "${imgLocal}" -resize ${W}x${H}^ -gravity center -extent ${W}x${H} "${fitted}"`);
    } else {
      await exec(`convert "${imgLocal}" -resize ${W}x${H} -background none -gravity center -extent ${W}x${H} "${fitted}"`);
    }
    await exec(`composite -gravity center "${fitted}" "${canvas}" "${canvas}"`);
  }
  const boxH = Math.max(120, Math.floor(H*0.22));
  if (topText && topText.text){
    const tpng=path.join(TMP_DIR,`ttop_${stamp()}.png`);
    await textToPngAuto(topText.text,W,boxH,TEXT_COLOR,"top",tpng);
    await exec(`composite -gravity north "${tpng}" "${canvas}" "${canvas}"`);
  }
  if (bottomText && bottomText.text){
    const bpng=path.join(TMP_DIR,`tbot_${stamp()}.png`);
    await textToPngAuto(bottomText.text,W,boxH,TEXT_COLOR,"bottom",bpng);
    await exec(`composite -gravity south "${bpng}" "${canvas}" "${canvas}"`);
  }
  return canvas;
}

async function renderImageSilent(outMp4, W,H,FPS, scene, duration, bgDefault){
  const contentUrl = scene.content && scene.content.url;
  const fit = (scene.content && scene.content.fit) || 'contain';
  const canvas = await composeCanvasPng(W,H,bgDefault,contentUrl,fit,scene.topText, scene.bottomText);
  const D = Math.max(1, Math.floor(duration||5));
  await exec(`ffmpeg -y -loop 1 -i "${canvas}" -t ${D} -r ${FPS} -vf "format=yuv420p" -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.1 "${outMp4}"`);
  return outMp4;
}

// ====== 動画シーン（文字は全尺ループで常時表示） ======
async function renderVideoSilent(outMp4, W,H,FPS, scene, duration){
  const vsrc = scene.content && scene.content.url;
  const fit = (scene.content && scene.content.fit) || 'contain';
  const vLocal = isHttp(vsrc)? await downloadToTemp(vsrc) : vsrc;
  const vf = fit==="cover" ? `scale=w=${W}:h=${H}:force_original_aspect_ratio=increase,crop=${W}:${H}` : `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;
  const D = Math.max(1, Math.floor(duration||5));
  const boxH = Math.max(120, Math.floor(H*0.22));
  const inputs=[`-i "${vLocal}"`];
  var idx=0; var filter=`[0:v]${vf}[v0]`; var last='[v0]';
  if (scene.topText && scene.topText.text){
    const tpng=path.join(TMP_DIR,`ttop_${stamp()}.png`);
    await textToPngAuto(scene.topText.text,W,boxH,TEXT_COLOR,"top",tpng);
    inputs.push(`-loop 1 -t ${D} -i "${tpng}"`);
    idx++; filter+=`;${last}[${idx}:v]overlay=x=(W-w)/2:y=40:format=auto[v${idx}]`.replace(/W/g,String(W)).replace(/H/g,String(H)); last=`[v${idx}]`;
  }
  if (scene.bottomText && scene.bottomText.text){
    const bpng=path.join(TMP_DIR,`tbot_${stamp()}.png`);
    await textToPngAuto(scene.bottomText.text,W,boxH,TEXT_COLOR,"bottom",bpng);
    inputs.push(`-loop 1 -t ${D} -i "${bpng}"`);
    idx++; filter+=`;${last}[${idx}:v]overlay=x=(W-w)/2:y=H-h-40:format=auto[v${idx}]`.replace(/W/g,String(W)).replace(/H/g,String(H)); last=`[v${idx}]`;
  }
  const fin = (scene.content && scene.content.effect && scene.content.effect.in) ? Number(scene.content.effect.in) : 0.6;
  const fout= (scene.content && scene.content.effect && scene.content.effect.out)? Number(scene.content.effect.out): 0.6;
  filter += `;${last}fade=t=in:st=0:d=${fin},fade=t=out:st=${Math.max(0,D-fout)}:d=${fout}[vout]`;
  const cmd = `ffmpeg -y ${inputs.join(' ')} -filter_complex "${filter}" -map "[vout]" -an -r ${FPS} -pix_fmt yuv420p -c:v libx264 -profile:v baseline -level 3.1 -t ${D} "${outMp4}"`;
  await exec(cmd);
  return { out: outMp4, vLocal };
}

// ====== シーン音声 / 元動画音声抽出 / mux ======
// REPLACE the whole function
async function buildSceneAudio(scene, speakerDefault, FPS){
  const topT = scene.topText && scene.topText.text ? String(scene.topText.text) : "";
  const botT = scene.bottomText && scene.bottomText.text ? String(scene.bottomText.text) : "";
  const spTop = scene.topText && !!scene.topText.speak;
  const spBot = scene.bottomText && !!scene.bottomText.speak;
  const spkTop = (scene.topText && scene.topText.speakerId) ? Number(scene.topText.speakerId) : speakerDefault;
  const spkBot = (scene.bottomText && scene.bottomText.speakerId) ? Number(scene.bottomText.speakerId) : speakerDefault;

  const minD = 5; // 固定（シーン最小秒）

  // 1) 上下テキストの音声を作成
  const wavs = [];
  if (spTop) { const f = path.join(TMP_DIR, `top_${stamp()}.wav`); await synthVoicevoxWav(topT, spkTop, f); wavs.push(f); }
  if (spBot) { const f = path.join(TMP_DIR, `bot_${stamp()}.wav`); await synthVoicevoxWav(botT, spkBot, f); wavs.push(f); }

  // 2) 連結し、最小5秒未満なら最後に無音を足して5秒ちょうど以上へ
  let voice = path.join(TMP_DIR, `voice_${stamp()}.wav`);
  if (wavs.length === 0) {
    await exec(`ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=stereo -t ${minD} -ar 48000 -ac 2 -f wav "${voice}"`);
  } else {
    await concatWavsSequential(voice, wavs);
    const d0 = await readMediaDurationSec(voice);
    if (d0 < minD - 0.01) {
      const pad = Math.max(0, minD - d0).toFixed(3);
      const v2 = path.join(TMP_DIR, `voice_pad_${stamp()}.wav`);
      await exec(
        `ffmpeg -y -i "${voice}" -f lavfi -t ${pad} -i anullsrc=r=48000:cl=stereo ` +
        `-filter_complex "[0:a]asetpts=PTS-STARTPTS[a0];[1:a]asetpts=PTS-STARTPTS[a1];` +
        `[a0][a1]concat=n=2:v=0:a=1,asetpts=PTS-STARTPTS[a]" ` +
        `-map "[a]" -ar 48000 -ac 2 -f wav "${v2}"`
      );
      voice = v2;
    } else {
      const nrm = path.join(TMP_DIR, `voice_norm_${stamp()}.wav`);
      await exec(`ffmpeg -y -i "${voice}" -ar 48000 -ac 2 -f wav "${nrm}"`);
      voice = nrm;
    }
  }

  // 3) SFX を声に重ねる（声は切らない／WAVで保持）
  const prog = path.join(TMP_DIR, `sceneprog_${stamp()}.wav`);
  await mixSfxOverVoice(prog, voice, scene.sfx || null);

  // 4) 尺を決める：音声の実長 + 安全マージン を FPS のフレーム境界へ切り上げ
  const voiceDur = await readMediaDurationSec(prog);   // ← これが抜けると「voiceDur is not defined」
  const fps = Number(FPS || 25);
  const safety = 0.12; // 120msくらい余裕を持たせる
  const target = Math.max(minD, voiceDur + safety);
  const frames = Math.ceil(target * fps);
  const finalDur = frames / fps;

  return { audio: prog, duration: finalDur };
}


// REPLACE the whole function
async function muxVideoAudio(outMp4, silentMp4, audioPath, duration, effect, srcAudio){
  const fin = (effect && effect.in) ? Number(effect.in) : 0.4;
  const fout= (effect && effect.out)? Number(effect.out) : 0.4;
  const D = Math.max(1, Math.floor(duration||5));

  if (srcAudio){
    // 元動画音声は D 秒で切る（声は切らない）
    const filter =
      `[0:v]setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fin},` +
      `fade=t=out:st=${Math.max(0,D-fout)}:d=${fout},` +
      `format=yuv420p[v];` +
      `[2:a]atrim=end=${D},asetpts=PTS-STARTPTS[src];` +
      `[1:a]asetpts=PTS-STARTPTS[v1];` +
      `[v1][src]amix=inputs=2:duration=first[a]`;
    const cmd =
      `ffmpeg -y -stream_loop -1 -i "${silentMp4}" -i "${audioPath}" -i "${srcAudio}" ` +
      `-t ${D} -filter_complex "${filter}" -map "[v]" -map "[a]" ` +
      `-c:v libx264 -pix_fmt yuv420p -c:a aac "${outMp4}"`;
    await exec(cmd);
  } else {
    const filter =
      `[0:v]setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fin},` +
      `fade=t=out:st=${Math.max(0,D-fout)}:d=${fout},` +
      `format=yuv420p[v]`;
    const cmd =
      `ffmpeg -y -stream_loop -1 -i "${silentMp4}" -i "${audioPath}" ` +
      `-t ${D} -filter_complex "${filter}" -map "[v]" -map 1:a ` +
      `-c:v libx264 -pix_fmt yuv420p -c:a aac "${outMp4}"`;
    await exec(cmd);
  }
  return outMp4;
}


async function concatVideos(files, finalOut){
  const list=path.join(TMP_DIR,`list_${stamp()}.txt`);
  fs.writeFileSync(list, files.map(function(f){ return `file '${f.replace(/'/g,"'\\''")}'`; }).join("\n"), "utf8");
  await exec(`ffmpeg -y -safe 0 -f concat -i "${list}" -c:v libx264 -preset veryfast -crf 22 -c:a aac -ar 48000 "${finalOut}"`);
  return finalOut;
}

async function addBgm(finalIn, bgm){
  if (!bgm || (!bgm.fsPath && !bgm.url)) return finalIn;
  const out = finalIn.replace(/\.mp4$/i, "_bgm.mp4");
  const vol = (typeof bgm.volume==='number') ? bgm.volume : 0.15;
  const loop = (typeof bgm.loop==='boolean') ? bgm.loop : true;
  const duck = !!bgm.duck;
  let bgmPath = "";
  if (bgm.fsPath) bgmPath = bgm.fsPath; else if (bgm.url && isHttp(bgm.url)) bgmPath = await downloadToTemp(bgm.url); else return finalIn;
  const loopOpt = loop ? "-stream_loop -1" : "";
  const duckCmd = `ffmpeg -y -i "${finalIn}" ${loopOpt} -i "${bgmPath}" -filter_complex "[1:a]volume=${vol}[bg];[bg][0:a]sidechaincompress=threshold=0.015:ratio=12:attack=5:release=1200[duck];[0:a][duck]amix=inputs=2:duration=first:dropout_transition=3[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${out}"`;
  const mixCmd  = `ffmpeg -y -i "${finalIn}" ${loopOpt} -i "${bgmPath}" -filter_complex "[1:a]volume=${vol}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=3[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${out}"`;
  try{ await exec(duck ? duckCmd : mixCmd); }catch(e){ if(duck){ await exec(mixCmd); } else { throw e; } }
  return out;
}

// ====== v1 互換の正規化（/api/render 用） ======
function normalizeV1(body){
  if (body && body.scenes) return body;
  const max = 4; const scenes=[];
  for (var i=1;i<=max;i++){
    var t = body["text_"+i] || "";
    var img = body["image_"+i] || "";
    if (!t && !img) continue;
    scenes.push({
      durationMin: 3,
      content: img ? { type:"image", url:img, fit:"contain", effect:{ name:"fade" } } : undefined,
      topText: t ? { text:t, speak:true, effect:{ name:"fade" } } : undefined
    });
  }
  return {
    meta: { title: body.title||"", description: body.description||"" },
    video: { width: Number(body.width||720), height: Number(body.height||1280), fps: Number(body.fps||25), bgColorDefault: body.bgColorDefault||"#212121" },
    voice: { engine: "voicevox", speakerId: Number(body.speakerId||2) },
    bgm: (body.bgm_url ? { url: body.bgm_url, volume: 0.15, duck: true, loop:true } : {}),
    scenes: scenes
  };
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
    const part = await buildSceneAudio(sc, spk, FPS);
    const D = Math.max(1, Math.floor(part.duration||5));

    const base = path.join(TMP_DIR,`base_${i+1}_${stamp()}.mp4`);
    let vLocalRef="";
    if (sc.content && sc.content.type==='video' && sc.content.url){
      const r = await renderVideoSilent(base, W,H,FPS, sc, D); vLocalRef = r.vLocal;
    } else {
      await renderImageSilent(base, W,H,FPS, sc, D, bgDefault);
    }

    const srcA = (sc.useSrcAudio && vLocalRef) ? (await (async()=>{ const out = path.join(TMP_DIR, `srca_${stamp()}.wav`); await exec(`ffmpeg -y -i "${vLocalRef}" -vn -t ${D} -ar 48000 -ac 2 -f wav "${out}"`); return out; })()) : "";

    const withAudio = path.join(TMP_DIR,`scene_${i+1}_${stamp()}.mp4`);
    const eff = (sc.content && sc.content.effect) ? sc.content.effect : {name:'fade'};
    await muxVideoAudio(withAudio, base, part.audio, D, eff, srcA);
    outs.push(withAudio);
  }

  const finalOut = path.join(OUT_DIR, `video_${stamp()}.mp4`);
  const list=path.join(TMP_DIR,`list_${stamp()}.txt`);
  fs.writeFileSync(list, outs.map(function(f){ return `file '${f.replace(/'/g,"'\\''")}'`; }).join("\n"),"utf8");
  await exec(`ffmpeg -y -safe 0 -f concat -i "${list}" -c:v libx264 -preset veryfast -crf 22 -c:a aac -ar 48000 "${finalOut}"`);
  const withBgm = await addBgm(finalOut, cfg.bgm||{});
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

// 静的配信（プレビュー用に /media/sfx, /media/bgm を公開）
app.use("/media/sfx", express.static(SFX_DIR, { fallthrough:false, immutable:true, maxAge: "7d" }));
app.use("/media/bgm", express.static(BGM_DIR, { fallthrough:false, immutable:true, maxAge: "7d" }));

// ヘルス
app.get("/health", async function(req,res){ let ff=false, im=false; try{ await exec("ffmpeg -version"); ff=true; }catch(_){ } try{ await exec("convert -version"); im=true; }catch(_){ } res.json({ ok:true, port:PORT, outDir:OUT_DIR, tmpDir:TMP_DIR, ffmpeg:ff, imagemagick:im, voicevox: VOICEVOX_BASE, font: FONT_PATH, sfxDir:SFX_DIR, bgmDir:BGM_DIR }); });

// VOICEVOX スピーカー一覧（プロキシ）
app.get("/api/voicevox/speakers", async function(req,res){
  try{
    const r = await axios.get(VOICEVOX_BASE + "/speakers", { timeout: 8000 });
    res.json({ ok:true, data: r.data });
  }catch(e){ res.status(500).json({ ok:false, error: errStr(e) }); }
});

// ---- 4コマ LITE フォーム（外部用） ----
const storage = multer.diskStorage({ destination: function(req,file,cb){ cb(null, UP_DIR); }, filename: function(req,file,cb){ cb(null, Date.now()+"_"+file.originalname.replace(/[^\w.\-]/g,"_")); } });
const fileFilter = function(req,file,cb){ const ok = /^image\/(png|jpe?g|webp)$|^video\/(mp4|quicktime)$|^audio\/(mpeg|mp3|wav|aac)$/i.test(file.mimetype); cb(ok?null:new Error("unsupported file type"), ok); };
const upload = multer({ storage, fileFilter, limits:{ fileSize: MAX_UPLOAD_MB*1024*1024 } });

function listAudioFiles(dir){ try{ return fs.readdirSync(dir).filter(function(n){ return /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(n); }).sort(); }catch(_){ return []; } }

app.get("/contest/4koma-lite", contestGuard, function(req,res){
  const sfx = listAudioFiles(SFX_DIR); const bgm = listAudioFiles(BGM_DIR);
  const tokenQs = PUBLIC_TOKEN?('?token='+PUBLIC_TOKEN):'';
  const css = `:root{--bg:#0b1020;--card:#121833;--ink:#eaf0ff;--muted:#b9c1d9;--accent:#7c5cff;--accent2:#2ee6a6;--radius:18px;--shadow:0 10px 30px rgba(0,0,0,.35)}html{scroll-behavior:smooth}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,'Hiragino Kaku Gothic ProN','Noto Sans JP','Yu Gothic',sans-serif;color:var(--ink);background:radial-gradient(1200px 600px at 10% -10%, rgba(124,92,255,.25), transparent 60%),radial-gradient(1000px 500px at 90% 0%, rgba(46,230,166,.15), transparent 55%),var(--bg);line-height:1.6}.container{max-width:1040px;margin:0 auto;padding:24px}.card{background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.07);border-radius:var(--radius);box-shadow:var(--shadow)}.pad{padding:1.5rem}.grid{display:grid;grid-template-columns:1fr;gap:1rem}@media(min-width:860px){.grid{grid-template-columns:repeat(2,1fr)}}h1{font-size:clamp(1.6rem,2vw+1.2rem,2.4rem);margin:.2rem 0 1rem}.muted{color:var(--muted)}label{font-weight:600;font-size:.95rem}.row{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:1rem;margin:.6rem 0}.inline{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap;justify-content:flex-start}.cta{display:inline-block;padding:12px 18px;border-radius:999px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#0a0f1a;font-weight:700;text-decoration:none;box-shadow:var(--shadow)}.cta:hover{filter:brightness(1.08)}input,select,textarea{width:100%;padding:.65rem .75rem;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.25);color:var(--ink)}input[type=color]{padding:.25rem;height:42px}audio{width:100%}input[type="checkbox"]{width:auto;height:auto;display:inline-block;vertical-align:middle;margin:0 .45rem 0 0}label.check{display:inline-flex;align-items:center;gap:.45rem}`;
  res.set("Content-Type","text/html; charset=utf-8");
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>4コマLITE</title>
  <style>${css}</style>
  <div class="container">
    <div class="card pad">
      <h1>4コマ動画ジェネレーター（LITE）</h1>
      <p class="muted">最低時間は各シーン5秒固定・効果はフェード固定。背景色は全体設定で一括。</p>
      <form method="POST" action="/contest/4koma-lite${tokenQs}" enctype="multipart/form-data">
        <input type="hidden" name="token" value="${PUBLIC_TOKEN}">
        <section class="row">
          <label>タイトル</label>
          <input name="title" placeholder="動画タイトル">
          <label style="margin-top:.6rem">説明</label>
          <textarea name="description" rows="2" placeholder="説明文"></textarea>
          <div class="grid" style="margin-top:.6rem">
            <div>
              <label>サイズ</label>
              <div class="inline"><input name="width" value="720" style="max-width:120px"><span>×</span><input name="height" value="1280" style="max-width:120px"><span>@</span><input name="fps" value="25" style="max-width:100px"><span>fps</span></div>
            </div>
            <div>
              <label>背景色（全体）</label>
              <div class="inline"><input type="color" id="bgColorPick" value="#212121" style="max-width:120px"><input id="bgColorText" name="bgColorDefault" value="#212121" placeholder="#212121"></div>
            </div>
          </div>
          <div class="grid" style="margin-top:.6rem")>
            <div>
              <label>読み上げスピーカー</label>
              <select id="speakerSel"><option value="2">(デフォルトID:2)</option></select>
              <input type="hidden" name="speakerId" id="speakerId" value="2">
            </div>
            <div>
              <label>BGM（ローカル選択）</label>
              <select id="bgmSel" name="bgm_file">
                <option value="">（なし）</option>
                ${bgm.map(function(f){return `<option value="${f}">${f}</option>`}).join("")}
              </select>
              <audio id="bgmAud" controls preload="none" style="margin-top:.4rem"></audio>
              <input type="hidden" name="bgm_duck" value="on">
            </div>
          </div>
        </section>
        ${[1,2,3,4].map(function(i){return `
        <section class="row">
          <h3 style="margin:.2rem 0 .6rem">シーン${i}</h3>
          <input type="hidden" name="minDuration_${i}" value="5">
          <div class="grid">
            <div>
              <label>コンテンツ（画像 / 動画）</label>
              <input type="file" name="content_${i}" accept="image/*,video/mp4,video/quicktime">
              <div class="inline" style="margin-top:.4rem">
                <input name="contentUrl_${i}" placeholder="URL指定（任意）">
              </div>
              <div class="inline" style="margin-top:.4rem">
                <label class="check"><input type="checkbox" name="muteSrcAudio_${i}" value="1">元動画の音源をオフにする</label>
              </div>
            </div>
            <div>
              <label>効果音（SFX）</label>
              <select id="sfxSel_${i}" name="sfx_${i}">
                <option value="">（なし）</option>
                ${sfx.map(function(f){return `<option value="${f}">${f}</option>`}).join("")}
              </select>
              <audio id="sfxAud_${i}" controls preload="none" style="margin-top:.4rem"></audio>
              <input type="hidden" name="sfxVolume_${i}" value="1">
            </div>
          </div>
          <div class="grid" style="margin-top:.6rem">
            <div>
              <label>上部テキスト</label>
              <input name="top_${i}" placeholder="上のテキスト">
              <label class="check" style="margin-top:.4rem"><input type="checkbox" name="speak_top_${i}" checked>読み上げ</label>
            </div>
            <div>
              <label>下部テキスト</label>
              <input name="bottom_${i}" placeholder="下のテキスト">
              <label class="check" style="margin-top:.4rem"><input type="checkbox" name="speak_bottom_${i}">読み上げ</label>
            </div>
          </div>
        </section>`}).join("")}
        <div class="inline" style="justify-content:flex-end; margin-top:.6rem">
          <button class="cta" type="submit">送信（生成をキューに追加）</button>
        </div>
      </form>
    </div>
  </div>
  <script>
    const pick=document.getElementById('bgColorPick'); const txt=document.getElementById('bgColorText'); pick.addEventListener('input',()=>{ txt.value=pick.value; }); txt.addEventListener('input',()=>{ if(/^#?[0-9a-fA-F]{6}$/.test(txt.value)){ pick.value = txt.value.startsWith('#')? txt.value : '#'+txt.value; }});
    const BGM_BASE='/media/bgm/', SFX_BASE='/media/sfx/';
    function bindPreview(selId,audId,base){ const sel=document.getElementById(selId); const aud=document.getElementById(audId); if(!sel||!aud) return; sel.addEventListener('change',()=>{ const v=sel.value; aud.src = v? (base + encodeURIComponent(v)) : ''; aud.pause(); if(v){ aud.load(); } }); }
    bindPreview('bgmSel','bgmAud',BGM_BASE);
    ${[1,2,3,4].map(i=>`bindPreview('sfxSel_${i}','sfxAud_${i}',SFX_BASE);`).join('')}
    // VOICEVOX speakers
    (async()=>{ try{ const r=await fetch('/api/voicevox/speakers'); const j=await r.json(); if(j && j.ok && Array.isArray(j.data)){ const sel=document.getElementById('speakerSel'); const hid=document.getElementById('speakerId'); sel.innerHTML=''; j.data.forEach(sp=>{ (sp.styles||[]).forEach(st=>{ const opt=document.createElement('option'); opt.value=String(st.id); opt.textContent=sp.name+ ' / ' + st.name + ' (ID:'+ st.id +')'; sel.appendChild(opt); }); }); sel.addEventListener('change',()=>{ hid.value=sel.value; }); } }catch(_){ /* ignore */ } })();
  </script>`);
});

app.post("/contest/4koma-lite", contestGuard, upload.any(), async function(req,res){
  try{
    const F={}; (req.files||[]).forEach(function(f){ F[f.fieldname]=f.path; });
    const B=req.body||{}; const scenes=[];
    for (var i=1;i<=4;i++){
      var top=B['top_'+i]||''; var bottom=B['bottom_'+i]||'';
      var cfile=F['content_'+i]||''; var curl=B['contentUrl_'+i]||''; var src=cfile||curl;
      var ctype = src && /\.(mp4|mov)$/i.test(src) ? 'video' : (src? 'image' : '');
      var muteSrc = !!B['muteSrcAudio_'+i];

      // SFX: 値は生ファイル名。プレビューは /media/sfx/ + encodeURIComponent(filename)
      var sfxName = B['sfx_'+i]||''; let sfxObj=null;
      if (sfxName){ try{ const fsPath = safeJoin(SFX_DIR, sfxName); if (fs.existsSync(fsPath)) sfxObj = { fsPath: fsPath, url: '/media/sfx/'+encodeURIComponent(sfxName), volume: 1.0 }; }catch(_){ /* ignore */ } }

      if (!top && !bottom && !src) continue;
      scenes.push({
        durationMin: 5,
        content: src? { type:ctype||'image', url:src, fit:'contain', effect:{name:'fade'} } : undefined,
        topText: top? { text:top, speak: !!B['speak_top_'+i], effect:{name:'fade'} } : undefined,
        bottomText: bottom? { text:bottom, speak: !!B['speak_bottom_'+i], effect:{name:'fade'} } : undefined,
        useSrcAudio: (!muteSrc) && ctype==='video',
        sfx: sfxObj
      });
    }

    // BGM: 値は生ファイル名（ffmpegには fsPath を渡す）
    const bgmFile = B['bgm_file']||''; let bgmObj={};
    if (bgmFile){ try{ const fsPath = safeJoin(BGM_DIR, bgmFile); if (fs.existsSync(fsPath)) bgmObj = { fsPath: fsPath, url:'/media/bgm/'+encodeURIComponent(bgmFile), volume:0.15, duck:true, loop:true }; }catch(_){ /* ignore */ } }

    const cfg={
      meta:{ title:B.title||'', description:B.description||'' },
      video:{ width:Number(B.width||720), height:Number(B.height||1280), fps:Number(B.fps||25), bgColorDefault:B.bgColorDefault||'#212121' },
      voice:{ engine:'voicevox', speakerId:Number(B.speakerId||2) },
      bgm: bgmObj,
      scenes: scenes
    };

    const id = enqueue(cfg);
    res.set("Content-Type","text/html; charset=utf-8");
    res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>受付完了</title>
      <h2 style="font-family:sans-serif;color:#eaf0ff;text-align:center;margin-top:2rem">受付しました</h2>
      <p style="text-align:center;color:#b9c1d9">ジョブID: <code>${id}</code></p>
      <div id="st" style="text-align:center;color:#b9c1d9">処理待ち...</div>
      <script>
        async function poll(){ try{ const r = await fetch('/api/jobs/${id}${PUBLIC_TOKEN?('?token='+PUBLIC_TOKEN):''}'); const j = await r.json(); if(!j.ok){ document.getElementById('st').textContent='エラー: '+(j.error||'unknown'); return; } if(j.status==='done'){ document.getElementById('st').innerHTML = '完了: <a href="'+ j.result.url +'">ダウンロード/再生</a>'; return; } if(j.status==='error'){ document.getElementById('st').textContent='失敗: '+(j.error||'unknown'); return; } document.getElementById('st').textContent = (j.status||'')+'...'; setTimeout(poll, 4000); }catch(e){ document.getElementById('st').textContent='通信エラー'; setTimeout(poll, 5000); } }
        poll();
      </script>`);
  }catch(e){ res.status(400).send(String(e && e.message || e)); }
});

// ---- ジョブAPI ----
const q=[]; var runningCount=0; const jobs=new Map();
app.post("/api/jobs", auth, bodyParser.json({limit:"10mb"}), function(req,res){ try{ if (q.length + runningCount >= MAX_QUEUE) return res.status(429).json({ ok:false, error:"queue full" }); const id = enqueue(req.body||{}); res.json({ ok:true, jobId:id }); }catch(e){ res.status(400).json({ ok:false, error: errStr(e) }); } });
app.get("/api/jobs/:id", function(req,res){ if (API_KEY) { const k = (req.headers["x-api-key"]||"").toString(); const t = ((req.query && req.query.token) || "").toString(); if (k !== API_KEY && !(PUBLIC_TOKEN && t === PUBLIC_TOKEN)) { return res.status(401).json({ ok:false, error:"unauthorized" }); } } const j = jobs.get(req.params.id); if (!j) return res.status(404).json({ ok:false, error:"not found" }); res.json({ ok:true, status:j.status, result:j.result, error:j.error }); });

// ---- 後方互換（同期） ----
app.post("/api/render", auth, bodyParser.json({limit:"10mb"}), bodyParser.urlencoded({ extended:true, limit:"10mb" }), async function(req,res){ try{ const cfg = normalizeV1(req.body||{}); const out = await renderFromConfig(cfg); const file = path.basename(out); res.json({ ok:true, file:file, url:"/output/"+file }); }catch(e){ res.status(400).json({ ok:false, error: errStr(e) }); } });

// ====== ジョブキュー ======
function enqueue(payload){ const cfg = payload && payload.scenes ? payload : normalizeV1(payload||{}); const id = Date.now().toString(36) + Math.random().toString(36).slice(2,8); jobs.set(id, { status:"queued", payload: cfg }); q.push(id); pump(); return id; }
async function workerOnce(id){ const j=jobs.get(id); if (!j) return; j.status="working"; try{ const out = await renderFromConfig(j.payload); const file = path.basename(out); j.status="done"; j.result={ file, url:"/output/"+file }; }catch(e){ j.status="error"; j.error=errStr(e); } }
async function pump(){ if (runningCount>=CONCURRENCY || q.length===0) return; const id=q.shift(); runningCount++; workerOnce(id).then(function(){ runningCount--; setImmediate(pump); }).catch(function(){ runningCount--; setImmediate(pump); }); }

// ====== 起動 ======
const appServer = http.createServer(app);
appServer.listen(PORT, function(){ console.log("4koma server listening on :"+PORT); });
