"use strict";
/*
 Re:NEMA 動画API v3（LITE / マルチ音声エンジン対応）

 ベース: re_nema_4_koma_server.js（v1）。v1 は一切変更していない。起動するファイルで切り替える。

 ── v1 からの変更点（第1弾） ────────────────────────────────
 1. 音声エンジンの抽象化
    - VOICEVOX と COEIROINK の両対応。COEIROINK は VOICEVOX 互換ではないため
      （/audio_query が無い・話者が speakerUuid + styleId の組）、エンジンごとにアダプタを持つ。
    - 話者は「プリセット名」で参照する。LLM に UUID を書かせないため。
 2. 尺の切り捨てバグ修正
    - v1 は buildSceneAudio がフレーム境界まで計算した小数の尺を、直後に Math.floor() で
      整数秒へ切り捨てていた。結果 -t が音声より短くなり、末尾が最大1秒弱切れていた。
      durationMin=5 が短い音声を 5.000 秒ちょうどに揃えていたため表面化していなかった。
 3. durationMin の配線
    - v1 は scenes[].durationMin を JSON にセットしていたが、どこからも読まず minD=5 固定だった。
      v3 は実際に読む。既定 0 =「パディングなし」。
 4. シーン数上限を MAX_SCENES（既定 20）に。v1 は 4 固定。
 5. 出力の隣に sidecar JSON を書く（cfg / 使用話者 / クレジット / 所要時間）。
    これが無いと「どの動画がどの条件で作られたか」が復元できず A/B テストが成立しない。

 ── まだ実装していない（schema_v2.md 参照） ──────────────────
 - transition（フェード以外の遷移）
 - outro（CTA・クレジットの動画への焼き込み）
 - content.srcAudioVolume（元動画音声の音量。v1 の ON/OFF 挙動のまま）

 !! 重要 !!
 COEIROINK の利用規約はクレジット表記を義務づけている（例:「COEIROINK:<合成音声名>」）。
 v3 はクレジット文字列を sidecar JSON とジョブ結果に出力するが、動画にはまだ焼き込まない。
 焼き込みが実装されるまで、COEIROINK 系の声で作った動画を公開しないこと。

 起動例:
   PORT=3100 \
   PUBLIC_TOKEN='abcd1234' \
   API_KEY='...' \
   VOICEVOX_BASE='http://127.0.0.1:50021' \
   COEIROINK_BASE='http://127.0.0.1:50032' \
   FONT_PATH='/root/re-nema_ffcreator/fonts/NotoSansJP-Regular.ttf' \
   node re_nema_4_koma_server_v3.js

 COEIROINK は自宅PC上で動くため、VPS からは SSH リバーストンネル経由で到達する:
   ssh -R 50032:127.0.0.1:50032 -L 3100:127.0.0.1:3100 root@<VPS>
 トンネルが無い間、COEIROINK 指定のジョブは "error" になる（無音動画を黙って作らない）。
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
const SFX_DIR = ENVPATH("SFX_DIR", "/root/re-nema_ffcreator/sounds/sfx");
const BGM_DIR = ENVPATH("BGM_DIR", "/root/re-nema_ffcreator/sounds/bgm");
function ENVPATH(k, d){ return process.env[k] || d; }
ensureDir(OUT_DIR); ensureDir(TMP_DIR); ensureDir(UP_DIR);
ensureDir(SFX_DIR); ensureDir(BGM_DIR);

const ENV = process.env;
const PORT = Number(ENV.PORT || 3000);
const API_KEY = ENV.API_KEY || "nemanemanema20250909nemaproject";
const PUBLIC_TOKEN = ENV.PUBLIC_TOKEN || "abcd1234";
const ALLOWED_ORIGINS = (ENV.ALLOWED_ORIGINS || "*").split(",");

const VOICEVOX_BASE  = ENV.VOICEVOX_BASE  || "http://127.0.0.1:50021";
const COEIROINK_BASE = ENV.COEIROINK_BASE || "http://127.0.0.1:50032";

const VOICEVOX_SPEED = Number(ENV.VOICEVOX_SPEED || 1.0);
const VOICEVOX_PAUSE = (ENV.VOICEVOX_PAUSE ? Number(ENV.VOICEVOX_PAUSE) : null);

const FONT_PATH  = ENV.FONT_PATH  || "/root/re-nema_ffcreator/fonts/NotoSansJP-Regular.ttf";
const TEXT_COLOR = ENV.TEXT_COLOR || "#ffffff";
const FAST = ENV.FAST === "1";
const MAX_UPLOAD_MB = Number(ENV.MAX_UPLOAD_MB || 50);
const MAX_QUEUE   = Number(ENV.MAX_QUEUE   || 50);
const CONCURRENCY = Number(ENV.CONCURRENCY || 1);

// v3 追加
const MAX_SCENES       = Number(ENV.MAX_SCENES       || 20);  // v1 は 4 固定
const DEFAULT_MIN_DUR  = Number(ENV.DEFAULT_MIN_DUR  || 0);   // 0 = パディング廃止
const SILENT_SCENE_DUR = Number(ENV.SILENT_SCENE_DUR || 3);   // 読み上げ無しシーンの尺
const SAMPLE_RATE      = Number(ENV.SAMPLE_RATE      || 48000);
// 1 にすると v1 同様「エンジン不達でも無音でレンダリング続行」に戻る
const VOICE_FALLBACK_SILENCE = ENV.VOICE_FALLBACK_SILENCE === "1";

// ====== 話者プリセット ======
// LLM にはこの表のキーだけを選ばせる（UUID を書かせない）。
// VOICES_JSON に JSON 文字列 or ファイルパスを渡せば差し替えられる。
const DEFAULT_VOICES = {
  "mycoe": {
    engine: "coeiroink",
    speakerUuid: "6482c5b6-25b7-11f0-bf36-c641f37a1721",
    styleId: 85727985,
    label: "自分の声（MYCOEIROINK / のーまる）"
  },
  "tsukuyomi": {
    engine: "coeiroink",
    speakerUuid: "3c37646f-3881-5374-2a83-149267990abc",
    styleId: 0,
    label: "つくよみちゃん（れいせい）"
  },
  "default": {
    engine: "voicevox",
    speakerId: 2,
    label: "VOICEVOX 既定(2)"
  }
};
const VOICES = loadVoices();
function loadVoices(){
  const raw = ENV.VOICES_JSON;
  if (!raw) return DEFAULT_VOICES;
  try{
    const txt = fs.existsSync(raw) ? fs.readFileSync(raw, "utf8") : raw;
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === "object") return parsed;
  }catch(e){ console.error("[VOICES] failed to parse VOICES_JSON, using defaults:", errStr(e)); }
  return DEFAULT_VOICES;
}

// ====== ユーティリティ ======
function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p, { recursive:true }); }
function stamp(){ const d=new Date(); const z=n=>String(n).padStart(2,"0"); return d.getFullYear()+z(d.getMonth()+1)+z(d.getDate())+"_"+z(d.getHours())+z(d.getMinutes())+z(d.getSeconds()); }
function errStr(e){ return (e && e.message) ? e.message : String(e); }
function isHttp(u){ return /^https?:\/\//i.test(String(u||"")); }

// v3: 尺は小数のまま扱う。ffmpeg の -t に渡す形へ整形するだけ。
// v1 はここで Math.floor していたため音声末尾が切れていた。
function fmtSec(x){
  const v = Number(x);
  return (Number.isFinite(v) && v > 0.04 ? v : 0.04).toFixed(3);
}

function isPrivateIp(ip){
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true;
  const parts = ip.split(".");
  if (parts.length === 4) {
    const a = Number(parts[0]), b = Number(parts[1]);
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}
function parseUrl(u){ try { return new urlmod.URL(u); } catch(_){ return null; } }
function lookupHost(host){
  return new Promise((resolve)=> {
    dns.lookup(host, { all:true, verbatim:true }, (err, addrs)=> resolve(err?[]:addrs.map(a=>a.address)));
  });
}
async function assertSafeHttpUrl(u){
  if (!isHttp(u)) throw new Error("Only http/https allowed");
  const p = parseUrl(u); if (!p) throw new Error("Invalid URL");
  if (net.isIP(p.hostname)) { if (isPrivateIp(p.hostname)) throw new Error("URL points to private IP"); return true; }
  const addrs = await lookupHost(p.hostname); if (!addrs.length) throw new Error("DNS lookup failed");
  if (addrs.some(isPrivateIp)) throw new Error("URL resolves to private IP");
  return true;
}
function safeJoin(baseDir, name){
  const p = path.normalize(path.join(baseDir, name));
  if (!p.startsWith(baseDir)) throw new Error("bad filename");
  return p;
}

// 軽量レート制限
const RATE = { windowMs: 60*1000, limit: 30 };
const rateMap = new Map();
function rateLimit(req,res,next){
  try{
    const ip = (req.headers["x-forwarded-for"]||"").toString().split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    const now = Date.now(); const rec = rateMap.get(ip) || { t: now, n: 0 };
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
  try{
    const { stdout } = await exec(`ffprobe -v error -show_format -of json "${file}"`);
    const info = JSON.parse(stdout);
    const d = info && info.format && info.format.duration ? Number(info.format.duration) : 0;
    return Math.max(0, d);
  }catch(_){ return 0; }
}

// 日本語長文でも確実に折り返すための簡易ラッパー
function softWrapText(text, maxCharsPerLine){
  const result = [];
  const lines = String(text||"").replace(/\r/g, "").split("\n");
  const forbidHead = /[、。,.，．）〕〉》」』】!?！？・:：；、。]/;

  for (const raw of lines){
    const chars = [...raw];
    let buf = "";
    for (let i = 0; i < chars.length; i++){
      buf += chars[i];
      if (buf.length >= maxCharsPerLine){
        while (i + 1 < chars.length && forbidHead.test(chars[i + 1])) {
          buf += chars[i + 1];
          i++;
        }
        result.push(buf);
        buf = "";
      }
    }
    if (buf) result.push(buf);
    if (chars.length === 0) result.push("");
  }
  return result.join("\n");
}

// ====== テキストPNG（自動折り返し + フィット） ======
async function textCaptionToPng(text, width, boxH, align, outPath, colorHex){
  const padW = Math.max(40, Math.floor(width * 0.08));
  const tgtW = Math.max(50, width - padW);
  const tgtH = Math.max(60, boxH - 20);
  const gravity = align === "top" ? "north" : (align === "bottom" ? "south" : "center");
  const esc = (s)=> String(s||"").replace(/\\/g,"\\\\").replace(/"/g,'\\"');
  let pt = 56;

  for (let tries = 0; tries < 6; tries++){
    const maxChars = Math.max(4, Math.floor(tgtW / (pt * 0.58)));
    const wrapped = softWrapText(text, maxChars);
    const tmp = outPath + ".try.png";
    const cmd = `convert -background none -fill "${colorHex||TEXT_COLOR}" ` +
                `-font "${FONT_PATH}" -pointsize ${pt} -gravity center ` +
                `-interline-spacing 4 -size ${tgtW}x${tgtH} caption:"${esc(wrapped)}" "${tmp}"`;
    await exec(cmd);

    const id = await exec(`identify -format "%w %h" "${tmp}"`);
    const parts = (id.stdout||"").trim().split(/\s+/).map(Number);
    const tw = parts[0]||tgtW, th = parts[1]||tgtH;

    if (tw <= tgtW && th <= tgtH) {
      await exec(`convert "${tmp}" -background none -gravity ${gravity} -extent ${width}x${boxH} "${outPath}"`);
      try{ fs.unlinkSync(tmp); }catch(_){}
      return outPath;
    }
    pt = Math.max(24, Math.floor(pt * 0.90));
    try{ fs.unlinkSync(tmp); }catch(_){}
  }

  const wrapped = softWrapText(text, Math.max(4, Math.floor(tgtW / (28 * 0.58))));
  await exec(`convert -background none -fill "${colorHex||TEXT_COLOR}" -font "${FONT_PATH}" -pointsize 28 -gravity ${gravity} -interline-spacing 4 -size ${tgtW}x${tgtH} caption:"${esc(wrapped)}" -extent ${width}x${boxH} "${outPath}"`);
  return outPath;
}

// ============================================================
// ====== 音声エンジン（v3 の中核） ======
// ============================================================
/*
 COEIROINK は VOICEVOX 互換ではない。実測（v2.11.0）:
   - /audio_query は存在しない。/v1/synthesis の一発呼び出し
   - 話者は speakerUuid(文字列) + styleId(整数) の「組」
   - 話者一覧は /v1/speakers（/speakers ではない）
   - ライセンス文は /v1/speaker_policy?speakerUuid=... から取得できる
 したがってベースURLの差し替えでは済まず、エンジンごとの実装が必要。
*/

// --- 話者メタのキャッシュ（クレジット自動生成用） ---
const metaCache = { voicevox: { at: 0, map: null }, coeiroink: { at: 0, map: null } };
const META_TTL_MS = 5 * 60 * 1000;

async function getVoicevoxMeta(){
  const c = metaCache.voicevox;
  if (c.map && (Date.now() - c.at) < META_TTL_MS) return c.map;
  const map = new Map();
  try{
    const r = await axios.get(VOICEVOX_BASE + "/speakers", { timeout: 10000 });
    (Array.isArray(r.data)? r.data:[]).forEach(sp=>{
      (Array.isArray(sp.styles)? sp.styles:[]).forEach(st=>{
        map.set(String(st.id), { speakerName: sp.name, styleName: st.name });
      });
    });
    c.map = map; c.at = Date.now();
  }catch(e){ console.error("[voicevox] speakers fetch failed:", errStr(e)); }
  return map;
}

async function getCoeiroinkMeta(){
  const c = metaCache.coeiroink;
  if (c.map && (Date.now() - c.at) < META_TTL_MS) return c.map;
  const map = new Map();
  try{
    const r = await axios.get(COEIROINK_BASE + "/v1/speakers", { timeout: 10000 });
    (Array.isArray(r.data)? r.data:[]).forEach(sp=>{
      (Array.isArray(sp.styles)? sp.styles:[]).forEach(st=>{
        map.set(sp.speakerUuid + ":" + st.styleId, { speakerName: sp.speakerName, styleName: st.styleName });
      });
    });
    c.map = map; c.at = Date.now();
  }catch(e){ console.error("[coeiroink] speakers fetch failed:", errStr(e)); }
  return map;
}

// --- VoiceRef の正規化 ---
/*
 受理する形:
   "mycoe"                                 プリセット名
   2 / "2"                                 VOICEVOX 話者ID（v1互換）
   "voicevox:3"
   "coeiroink:<uuid>:<styleId>"
   { engine:"coeiroink", speakerUuid, styleId } / { engine:"voicevox", speakerId }
*/
function resolveVoice(ref, fallback){
  const v = normalizeVoiceRef(ref);
  if (v) return v;
  const f = normalizeVoiceRef(fallback);
  if (f) return f;
  return { engine: "voicevox", speakerId: 2, source: "hardfallback" };
}

function normalizeVoiceRef(ref){
  if (ref === null || ref === undefined || ref === "") return null;

  if (typeof ref === "object"){
    const eng = String(ref.engine||"").toLowerCase();
    if (eng === "coeiroink" && ref.speakerUuid !== undefined)
      return { engine:"coeiroink", speakerUuid:String(ref.speakerUuid), styleId:Number(ref.styleId||0), credit:ref.credit, label:ref.label, source:"object" };
    if (eng === "voicevox" && ref.speakerId !== undefined)
      return { engine:"voicevox", speakerId:Number(ref.speakerId), credit:ref.credit, label:ref.label, source:"object" };
    return null;
  }

  if (typeof ref === "number" && Number.isFinite(ref))
    return { engine:"voicevox", speakerId: ref, source:"number" };

  const s = String(ref).trim();
  if (!s) return null;

  // プリセット名
  if (Object.prototype.hasOwnProperty.call(VOICES, s)){
    const p = VOICES[s];
    const n = normalizeVoiceRef(p);
    if (n) { n.preset = s; n.label = p.label || s; n.credit = p.credit || n.credit; n.source = "preset"; return n; }
    return null;
  }

  if (/^\d+$/.test(s)) return { engine:"voicevox", speakerId: Number(s), source:"numeric-string" };

  const mv = s.match(/^voicevox:(\d+)$/i);
  if (mv) return { engine:"voicevox", speakerId: Number(mv[1]), source:"prefixed" };

  const mc = s.match(/^coeiroink:([^:]+):(\d+)$/i);
  if (mc) return { engine:"coeiroink", speakerUuid: mc[1], styleId: Number(mc[2]), source:"prefixed" };

  return null;
}

function voiceKey(v){
  return v.engine === "coeiroink" ? `coeiroink:${v.speakerUuid}:${v.styleId}` : `voicevox:${v.speakerId}`;
}

// クレジット文字列。プリセットに credit があればそれを使い、無ければ話者名から生成する。
// COEIROINK の規約が求める形式:「COEIROINK:<合成音声名>」
async function creditFor(v){
  if (v.credit) return v.credit;
  try{
    if (v.engine === "coeiroink"){
      const m = await getCoeiroinkMeta();
      const hit = m.get(v.speakerUuid + ":" + v.styleId);
      return "COEIROINK:" + (hit ? hit.speakerName : v.speakerUuid);
    } else {
      const m = await getVoicevoxMeta();
      const hit = m.get(String(v.speakerId));
      return "VOICEVOX:" + (hit ? hit.speakerName : v.speakerId);
    }
  }catch(_){ }
  return v.engine === "coeiroink" ? "COEIROINK" : "VOICEVOX";
}

// --- アダプタ: VOICEVOX（2段階: audio_query -> synthesis） ---
async function synthVoicevoxRaw(text, v, outRawWav){
  const q = await axios.post(VOICEVOX_BASE + "/audio_query", null, {
    params:{ text:String(text), speaker: v.speakerId }, timeout:15000
  });
  try{
    if (VOICEVOX_SPEED && VOICEVOX_SPEED !== 1) q.data.speedScale = VOICEVOX_SPEED;
    if (typeof VOICEVOX_PAUSE === "number" && !Number.isNaN(VOICEVOX_PAUSE)) q.data.pauseLengthScale = VOICEVOX_PAUSE;
  }catch(_){ }
  const s = await axios.post(VOICEVOX_BASE + "/synthesis", q.data, {
    params:{ speaker: v.speakerId }, responseType:"arraybuffer", timeout:60000
  });
  fs.writeFileSync(outRawWav, Buffer.from(s.data));
  return outRawWav;
}

// --- アダプタ: COEIROINK（1段階: /v1/synthesis） ---
async function synthCoeiroinkRaw(text, v, outRawWav){
  // SynthesisParam の必須フィールドは全て送る必要がある
  const body = {
    speakerUuid: v.speakerUuid,
    styleId: Number(v.styleId||0),
    text: String(text),
    speedScale: (VOICEVOX_SPEED && Number.isFinite(VOICEVOX_SPEED)) ? VOICEVOX_SPEED : 1.0,
    volumeScale: 1.0,
    pitchScale: 0.0,
    intonationScale: 1.0,
    prePhonemeLength: 0.1,
    postPhonemeLength: 0.1,
    outputSamplingRate: SAMPLE_RATE
  };
  if (typeof VOICEVOX_PAUSE === "number" && !Number.isNaN(VOICEVOX_PAUSE)) body.pauseLength = VOICEVOX_PAUSE;

  const s = await axios.post(COEIROINK_BASE + "/v1/synthesis", body, {
    responseType:"arraybuffer", timeout:120000, headers:{ "Content-Type":"application/json" }
  });
  fs.writeFileSync(outRawWav, Buffer.from(s.data));
  return outRawWav;
}

/*
 テキスト -> wav（48kHz/stereo に正規化して outPath へ）
 v1 との挙動差: エンジンに到達できなかった場合、既定では例外を投げてジョブを失敗させる。
 v1 は黙って無音を返していたため「無音の動画が正常終了として出来上がる」事故が起きうる。
 VOICE_FALLBACK_SILENCE=1 で v1 の挙動に戻せる。
*/
async function synthToWav(text, v, outPath){
  if (!text){
    await exec(`ffmpeg -y -f lavfi -i anullsrc=r=${SAMPLE_RATE}:cl=stereo -t 0.1 "${outPath}"`);
    return outPath;
  }
  const raw = outPath + ".raw.wav";
  try{
    if (v.engine === "coeiroink") await synthCoeiroinkRaw(text, v, raw);
    else                          await synthVoicevoxRaw(text, v, raw);
  }catch(e){
    const msg = `[${v.engine}] synthesis failed (${voiceKey(v)}): ${errStr(e)}`;
    console.error(msg);
    if (!VOICE_FALLBACK_SILENCE){
      const hint = v.engine === "coeiroink"
        ? " / COEIROINK に到達できません。自宅PCで COEIROINK を起動し SSH リバーストンネル(-R 50032:127.0.0.1:50032)が張られているか確認してください"
        : "";
      throw new Error(msg + hint);
    }
    await exec(`ffmpeg -y -f lavfi -i anullsrc=r=${SAMPLE_RATE}:cl=stereo -t 0.5 "${outPath}"`);
    return outPath;
  }

  // 後処理。VOICEVOX は先頭の無音を軽く落とす（v1 と同じ）。
  // COEIROINK は prePhonemeLength で先頭長を直接指定しているので silenceremove はかけない
  // （自分の声の立ち上がりを削らないため）。
  const af = (v.engine === "voicevox")
    ? `-af "silenceremove=start_periods=1:start_silence=0.25:start_threshold=-40dB" `
    : "";
  await exec(`ffmpeg -y -i "${raw}" ${af}-ar ${SAMPLE_RATE} -ac 2 -f wav "${outPath}"`);
  try{ fs.unlinkSync(raw); }catch(_){ }
  return outPath;
}

// ====== 音声の連結・重畳 ======
async function concatWavsSequential(outPath, inputs){
  const norm=[];
  for (let i=0;i<inputs.length;i++){
    if(!inputs[i]) continue;
    const n=path.join(TMP_DIR,`norm_${i}_${stamp()}.wav`);
    await exec(`ffmpeg -y -i "${inputs[i]}" -ar ${SAMPLE_RATE} -ac 2 -f wav "${n}"`);
    norm.push(n);
  }
  if(!norm.length){
    await exec(`ffmpeg -y -f lavfi -i anullsrc=r=${SAMPLE_RATE}:cl=stereo -t 0.1 "${outPath}"`);
    return outPath;
  }
  const list=path.join(TMP_DIR,`wavlist_${stamp()}.txt`);
  fs.writeFileSync(list, norm.map(p=>`file '${p.replace(/'/g,"'\\''")}'`).join("\n"),"utf8");
  await exec(`ffmpeg -y -safe 0 -f concat -i "${list}" -c copy "${outPath}"`);
  return outPath;
}

// SFX を音声に重ねる（声は切らない。出力は声の長さちょうど）
async function mixSfxOverVoice(outPath, voiceWav, sfxObj){
  if (!sfxObj){ fs.copyFileSync(voiceWav, outPath); return outPath; }
  let sfxPath = "";
  if (sfxObj.fsPath && fs.existsSync(sfxObj.fsPath)) sfxPath = sfxObj.fsPath;
  else if (sfxObj.url && isHttp(sfxObj.url)) sfxPath = await downloadToTemp(sfxObj.url);
  else { fs.copyFileSync(voiceWav, outPath); return outPath; }

  const vol = (typeof sfxObj.volume === "number") ? sfxObj.volume : 1.0;
  const D = Math.max(0.1, await readMediaDurationSec(voiceWav));

  const filter =
    `[0:a]asetpts=PTS-STARTPTS[v];`+
    `[1:a]volume=${vol},atrim=end=${fmtSec(D)},asetpts=PTS-STARTPTS[s];`+
    `[v][s]amix=inputs=2:duration=first[a]`;
  const cmd = `ffmpeg -y -i "${voiceWav}" -i "${sfxPath}" -filter_complex "${filter}" -map "[a]" -ar ${SAMPLE_RATE} -ac 2 -f wav "${outPath}"`;
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
    await textCaptionToPng(topText.text,W,boxH,"top",tpng,TEXT_COLOR);
    await exec(`composite -gravity north "${tpng}" "${canvas}" "${canvas}"`);
  }
  if (bottomText && bottomText.text){
    const bpng=path.join(TMP_DIR,`tbot_${stamp()}.png`);
    await textCaptionToPng(bottomText.text,W,boxH,"bottom",bpng,TEXT_COLOR);
    await exec(`composite -gravity south "${bpng}" "${canvas}" "${canvas}"`);
  }
  return canvas;
}

// v3: duration は小数のまま
async function renderImageSilent(outMp4, W,H,FPS, scene, duration, bgDefault){
  const contentUrl = scene.content && scene.content.url;
  const fit = (scene.content && scene.content.fit) || 'contain';
  const canvas = await composeCanvasPng(W,H,bgDefault,contentUrl,fit,scene.topText, scene.bottomText);
  await exec(`ffmpeg -y -loop 1 -i "${canvas}" -t ${fmtSec(duration)} -r ${FPS} -vf "format=yuv420p,setpts=PTS-STARTPTS" -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.1 "${outMp4}"`);
  return outMp4;
}

// ====== 動画シーン ======
async function renderVideoSilent(outMp4, W,H,FPS, scene, duration){
  const vsrc = scene.content && scene.content.url;
  const fit = (scene.content && scene.content.fit) || 'contain';
  const vLocal = isHttp(vsrc)? await downloadToTemp(vsrc) : vsrc;
  const vf = fit==="cover" ? `scale=w=${W}:h=${H}:force_original_aspect_ratio=increase,crop=${W}:${H}` : `scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;
  const D = fmtSec(duration);
  const boxH = Math.max(120, Math.floor(H*0.22));

  const inputs=[`-i "${vLocal}"`];
  let idx=0; let filter=`[0:v]${vf},setpts=PTS-STARTPTS[v0]`; let last='[v0]';

  if (scene.topText && scene.topText.text){
    const tpng=path.join(TMP_DIR,`ttop_${stamp()}.png`);
    await textCaptionToPng(scene.topText.text,W,boxH,"top",tpng,TEXT_COLOR);
    inputs.push(`-loop 1 -t ${D} -i "${tpng}"`);
    idx++; filter+=`;${last}[${idx}:v]overlay=x=(W-w)/2:y=40:format=auto[v${idx}]`.replace(/W/g,String(W)).replace(/H/g,String(H)); last=`[v${idx}]`;
  }
  if (scene.bottomText && scene.bottomText.text){
    const bpng=path.join(TMP_DIR,`tbot_${stamp()}.png`);
    await textCaptionToPng(scene.bottomText.text,W,boxH,"bottom",bpng,TEXT_COLOR);
    inputs.push(`-loop 1 -t ${D} -i "${bpng}"`);
    idx++; filter+=`;${last}[${idx}:v]overlay=x=(W-w)/2:y=H-h-40:format=auto[v${idx}]`.replace(/W/g,String(W)).replace(/H/g,String(H)); last=`[v${idx}]`;
  }

  const cmd = `ffmpeg -y ${inputs.join(' ')} -filter_complex "${filter}" -map "${last}" -an -r ${FPS} -pix_fmt yuv420p -c:v libx264 -profile:v baseline -level 3.1 -t ${D} "${outMp4}"`;
  await exec(cmd);
  return { out: outMp4, vLocal };
}

// ====== シーン音声 ======
async function buildSceneAudio(scene, voiceDefault, FPS, sceneIndex){
  const topT = scene.topText && scene.topText.text ? String(scene.topText.text) : "";
  const botT = scene.bottomText && scene.bottomText.text ? String(scene.bottomText.text) : "";
  const spTop = scene.topText && !!scene.topText.speak;
  const spBot = scene.bottomText && !!scene.bottomText.speak;

  // v3: 話者はシーン・位置単位で指定可能。未指定なら全体設定にフォールバック。
  //     v1 の scene.*.speakerId（整数）も resolveVoice が受理する。
  const vTop = resolveVoice(
    (scene.topText && (scene.topText.voice !== undefined ? scene.topText.voice : scene.topText.speakerId)),
    voiceDefault);
  const vBot = resolveVoice(
    (scene.bottomText && (scene.bottomText.voice !== undefined ? scene.bottomText.voice : scene.bottomText.speakerId)),
    voiceDefault);

  // v3: v1 は minD=5 のハードコードだった。durationMin を実際に読む。
  const minD = (typeof scene.durationMin === "number" && Number.isFinite(scene.durationMin))
    ? Math.max(0, scene.durationMin)
    : DEFAULT_MIN_DUR;

  const usedVoices = [];

  // 1) 上下テキストの音声
  const wavs = [];
  if (spTop && topT) { const f = path.join(TMP_DIR, `top_${stamp()}.wav`); await synthToWav(topT, vTop, f); wavs.push(f); usedVoices.push(vTop); }
  if (spBot && botT) { const f = path.join(TMP_DIR, `bot_${stamp()}.wav`); await synthToWav(botT, vBot, f); wavs.push(f); usedVoices.push(vBot); }

  // 2) 連結 → durationMin に満たなければ差分だけ無音を末尾に足す
  let voice = path.join(TMP_DIR, `voice_${stamp()}.wav`);
  if (wavs.length === 0) {
    // 読み上げ無しシーン。minD が 0 だと長さ0になってしまうため既定値を使う。
    const d = minD > 0 ? minD : SILENT_SCENE_DUR;
    await exec(`ffmpeg -y -f lavfi -i anullsrc=r=${SAMPLE_RATE}:cl=stereo -t ${fmtSec(d)} -ar ${SAMPLE_RATE} -ac 2 -f wav "${voice}"`);
  } else {
    await concatWavsSequential(voice, wavs);
    const d0 = await readMediaDurationSec(voice);
    if (minD > 0 && d0 < minD - 0.001) {
      const pad = (minD - d0);
      const v2 = path.join(TMP_DIR, `voice_pad_${stamp()}.wav`);
      await exec(
        `ffmpeg -y -i "${voice}" -f lavfi -t ${fmtSec(pad)} -i anullsrc=r=${SAMPLE_RATE}:cl=stereo ` +
        `-filter_complex "[0:a]asetpts=PTS-STARTPTS[a0];[1:a]asetpts=PTS-STARTPTS[a1];[a0][a1]concat=n=2:v=0:a=1[a]" ` +
        `-map "[a]" -ar ${SAMPLE_RATE} -ac 2 -f wav "${v2}"`
      );
      voice = v2;
    } else {
      const nrm = path.join(TMP_DIR, `voice_norm_${stamp()}.wav`);
      await exec(`ffmpeg -y -i "${voice}" -ar ${SAMPLE_RATE} -ac 2 -f wav "${nrm}"`);
      voice = nrm;
    }
  }

  // 3) SFX 重畳（声は切らない）
  const prog = path.join(TMP_DIR, `sceneprog_${stamp()}.wav`);
  await mixSfxOverVoice(prog, voice, scene.sfx || null);

  // 4) 尺: 音声の実長 + 安全マージン を FPS のフレーム境界へ切り上げ
  const voiceDur = await readMediaDurationSec(prog);
  const fps = Number(FPS || 25);
  const safety = 0.12;
  const target = Math.max(minD, voiceDur + safety);
  const frames = Math.ceil(target * fps);
  const finalDur = frames / fps;

  // durationMax はエンジンでは強制しない（音声を切る/早口にするしかないため）。警告のみ。
  if (typeof scene.durationMax === "number" && finalDur > scene.durationMax + 0.001){
    console.warn(`[scene ${sceneIndex+1}] duration ${finalDur.toFixed(2)}s exceeds durationMax ${scene.durationMax}s (台本側で文字数を調整してください)`);
  }

  return { audio: prog, duration: finalDur, usedVoices };
}

// v3: duration は小数のまま。v1 はここでも Math.floor していた。
async function muxVideoAudio(outMp4, silentMp4, audioPath, duration, effect, srcAudio){
  const fin = (effect && effect.in) ? Number(effect.in) : 0.2;
  const fout= (effect && effect.out)? Number(effect.out): 0.2;
  const dNum = Number(duration) > 0.04 ? Number(duration) : 0.04;
  const D = fmtSec(dNum);
  const fadeOutStart = fmtSec(Math.max(0, dNum - fout));

  if (srcAudio){
    const filter = `[0:v]setpts=PTS-STARTPTS,fade=t=in:st=0:d=${fin},fade=t=out:st=${fadeOutStart}:d=${fout},format=yuv420p[v];`+
                   `[2:a]atrim=end=${D},asetpts=PTS-STARTPTS[src];`+
                   `[1:a]asetpts=PTS-STARTPTS[v1];`+
                   `[v1][src]amix=inputs=2:duration=first[a]`;
    const cmd = `ffmpeg -y -stream_loop -1 -i "${silentMp4}" -i "${audioPath}" -i "${srcAudio}" -t ${D} -filter_complex "${filter}" -map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac "${outMp4}"`;
    await exec(cmd);
  } else {
    const filter = `[0:v]setpts=PTS-STARTPTS,fade=t=in:st=0:d=${fin},fade=t=out:st=${fadeOutStart}:d=${fout},format=yuv420p[v]`;
    const cmd = `ffmpeg -y -stream_loop -1 -i "${silentMp4}" -i "${audioPath}" -t ${D} -filter_complex "${filter}" -map "[v]" -map 1:a -c:v libx264 -pix_fmt yuv420p -c:a aac "${outMp4}"`;
    await exec(cmd);
  }
  return outMp4;
}

async function concatVideos(files, finalOut){
  const list=path.join(TMP_DIR,`list_${stamp()}.txt`);
  fs.writeFileSync(list, files.map(f=>`file '${f.replace(/'/g,"'\\''")}'`).join("\n"), "utf8");
  await exec(`ffmpeg -y -safe 0 -f concat -i "${list}" -fflags +genpts -af aresample=async=1:first_pts=0 -c:v libx264 -preset veryfast -crf 22 -c:a aac -ar ${SAMPLE_RATE} "${finalOut}"`);
  return finalOut;
}

async function addBgm(finalIn, bgm){
  if (!bgm || (!bgm.fsPath && !bgm.url)) return finalIn;

  const out = finalIn.replace(/\.mp4$/i, "_bgm.mp4");
  const vol = (typeof bgm.volume==='number') ? bgm.volume : 0.15;
  const loop = (typeof bgm.loop==='boolean') ? bgm.loop : true;

  let bgPath = "";
  if (bgm.fsPath) bgPath = bgm.fsPath;
  else if (bgm.url) bgPath = bgm.url;
  else return finalIn;

  const loopOpt = loop ? "-stream_loop -1" : "";

  const primary =
    `ffmpeg -y -i "${finalIn}" ${loopOpt} -i "${bgPath}" ` +
    `-filter_complex "[1:a]volume=${vol}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=3[a]" ` +
    `-map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${out}"`;

  const fallback =
    `ffmpeg -y -i "${finalIn}" ${loopOpt} -i "${bgPath}" ` +
    `-filter_complex "[1:a]volume=${vol},aresample=${SAMPLE_RATE}[a]" ` +
    `-map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${out}"`;

  try { await exec(primary); }
  catch { await exec(fallback); }

  return out;
}

// ====== v1 互換の正規化 ======
function normalizeV1(body){
  if (body && body.scenes) return body;
  const scenes=[];
  for (let i=1;i<=MAX_SCENES;i++){
    const t = body["text_"+i] || "";
    const img = body["image_"+i] || "";
    if (!t && !img) continue;
    scenes.push({
      durationMin: DEFAULT_MIN_DUR,
      content: img ? { type:"image", url:img, fit:"contain", effect:{ name:"fade" } } : undefined,
      topText: t ? { text:t, speak:true, effect:{ name:"fade" } } : undefined
    });
  }
  return {
    meta: { title: body.title||"", description: body.description||"", variant: body.variant||"" },
    video: { width: Number(body.width||720), height: Number(body.height||1280), fps: Number(body.fps||25), bgColorDefault: body.bgColorDefault||"#212121" },
    // v1 の speakerId（整数）も v3 の ref（プリセット名）も同じ場所で受ける
    voice: { ref: (body.voiceRef !== undefined && body.voiceRef !== "") ? body.voiceRef : Number(body.speakerId||2) },
    bgm: (body.bgm_url ? { url: body.bgm_url, volume: 0.15, loop:true } : {}),
    scenes
  };
}

// ====== レンダリング本体 ======
async function renderFromConfig(cfg){
  const t0 = Date.now();
  const W = cfg.video && cfg.video.width ? Number(cfg.video.width) : 720;
  const H = cfg.video && cfg.video.height ? Number(cfg.video.height) : 1280;
  const FPS = cfg.video && cfg.video.fps ? Number(cfg.video.fps) : 25;
  const bgDefault = (cfg.video && cfg.video.bgColorDefault) || "#212121";

  // 全体の既定話者。v1 の cfg.voice.speakerId も受理する。
  const voiceDefault = (cfg.voice && cfg.voice.ref !== undefined && cfg.voice.ref !== "")
    ? cfg.voice.ref
    : (cfg.voice && cfg.voice.speakerId !== undefined ? Number(cfg.voice.speakerId) : 2);

  const outs=[]; const scenes = cfg.scenes || [];
  const allVoices = new Map();

  for (let i=0;i<scenes.length && i<MAX_SCENES;i++){
    const sc = scenes[i];
    const part = await buildSceneAudio(sc, voiceDefault, FPS, i);
    (part.usedVoices||[]).forEach(v=> allVoices.set(voiceKey(v), v));

    // v3: 小数のまま渡す（v1 は Math.floor で切り捨てていた）
    const D = part.duration;

    const base = path.join(TMP_DIR,`base_${i+1}_${stamp()}.mp4`);
    let vLocalRef="";
    if (sc.content && sc.content.type==='video' && sc.content.url){
      const r = await renderVideoSilent(base, W,H,FPS, sc, D); vLocalRef = r.vLocal;
    } else {
      await renderImageSilent(base, W,H,FPS, sc, D, bgDefault);
    }

    const srcA = (sc.useSrcAudio && vLocalRef)
      ? (await (async()=>{ const out = path.join(TMP_DIR, `srca_${stamp()}.wav`); await exec(`ffmpeg -y -i "${vLocalRef}" -vn -t ${fmtSec(D)} -ar ${SAMPLE_RATE} -ac 2 -f wav "${out}"`); return out; })())
      : "";

    const withAudio = path.join(TMP_DIR,`scene_${i+1}_${stamp()}.mp4`);
    const eff = (sc.content && sc.content.effect) ? sc.content.effect : {name:'fade'};
    await muxVideoAudio(withAudio, base, part.audio, D, eff, srcA);
    outs.push(withAudio);
  }

  if (!outs.length) throw new Error("no renderable scenes");

  const finalOut = path.join(OUT_DIR, `video_${stamp()}.mp4`);
  await concatVideos(outs, finalOut);
  const withBgm = await addBgm(finalOut, cfg.bgm||{});

  // ---- sidecar JSON（A/B テストの前提。v1 は cfg を破棄していた）----
  const credits = [];
  for (const v of allVoices.values()){
    credits.push({ voice: voiceKey(v), engine: v.engine, preset: v.preset||null, credit: await creditFor(v) });
  }
  const meta = {
    renderedAt: new Date().toISOString(),
    elapsedSec: Number(((Date.now()-t0)/1000).toFixed(2)),
    output: path.basename(withBgm),
    variant: (cfg.meta && cfg.meta.variant) || "",
    sceneCount: outs.length,
    credits,
    creditLine: credits.map(c=>c.credit).join(" / "),
    config: cfg
  };
  try{ fs.writeFileSync(withBgm + ".json", JSON.stringify(meta, null, 2), "utf8"); }
  catch(e){ console.error("[sidecar] write failed:", errStr(e)); }

  return { file: withBgm, meta };
}

// ====== Express サーバ ======
const app = express();
app.use((req,res,next)=>{
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
app.get("/output/:file", (req,res)=>{
  const file = path.basename(req.params.file || "");
  const p = path.join(OUT_DIR, file);
  if (!p.startsWith(OUT_DIR)) return res.status(400).send("bad path");
  if (!fs.existsSync(p)) return res.status(404).send("not found");
  res.sendFile(p);
});

app.use("/media/sfx", express.static(SFX_DIR, { fallthrough:false, immutable:true, maxAge: "7d" }));
app.use("/media/bgm", express.static(BGM_DIR, { fallthrough:false, immutable:true, maxAge: "7d" }));

// ヘルス（v3: 両エンジンの到達性を出す）
app.get("/health", async (req,res)=>{
  let ff=false, im=false;
  try{ await exec("ffmpeg -version"); ff=true; }catch(_){}
  try{ await exec("convert -version"); im=true; }catch(_){}

  const engines = {};
  try{ await axios.get(VOICEVOX_BASE + "/version", { timeout: 3000 }); engines.voicevox = { base: VOICEVOX_BASE, reachable: true }; }
  catch(e){ engines.voicevox = { base: VOICEVOX_BASE, reachable: false, error: errStr(e) }; }
  try{ const r = await axios.get(COEIROINK_BASE + "/v1/engine_info", { timeout: 3000 }); engines.coeiroink = { base: COEIROINK_BASE, reachable: true, info: r.data }; }
  catch(e){ engines.coeiroink = { base: COEIROINK_BASE, reachable: false, error: errStr(e), hint: "自宅PCで COEIROINK を起動し、ssh -R 50032:127.0.0.1:50032 でトンネルを張ってください" }; }

  res.json({ ok:true, version:"v3", port:PORT, outDir:OUT_DIR, tmpDir:TMP_DIR,
    ffmpeg:ff, imagemagick:im, engines, font: FONT_PATH, sfxDir:SFX_DIR, bgmDir:BGM_DIR,
    presets: Object.keys(VOICES), defaultMinDur: DEFAULT_MIN_DUR, maxScenes: MAX_SCENES });
});

// v3: 全エンジンの話者を1つのリストで返す
app.get("/api/voices", contestGuard, async (req,res)=>{
  const voices = [];
  for (const key of Object.keys(VOICES)){
    const v = normalizeVoiceRef(key);
    if (!v) continue;
    voices.push({ ref: key, label: VOICES[key].label || key, engine: v.engine, preset: true, credit: await creditFor(v) });
  }
  try{
    const m = await getVoicevoxMeta();
    for (const [id, info] of m.entries()){
      voices.push({ ref: "voicevox:"+id, label: `${info.speakerName} / ${info.styleName} (${id})`, engine:"voicevox", preset:false });
    }
  }catch(_){ }
  try{
    const m = await getCoeiroinkMeta();
    for (const [k, info] of m.entries()){
      voices.push({ ref: "coeiroink:"+k, label: `${info.speakerName} / ${info.styleName}`, engine:"coeiroink", preset:false });
    }
  }catch(_){ }
  res.json({ ok:true, voices });
});

// v1 互換: VOICEVOX のみの話者一覧
app.get("/api/voicevox/speakers", contestGuard, async (req,res)=>{
  try{
    const r = await axios.get(VOICEVOX_BASE + "/speakers", { timeout: 10000 });
    const list = (Array.isArray(r.data)? r.data:[]).flatMap(sp=>{
      const name = sp.name; const styles = Array.isArray(sp.styles)? sp.styles:[];
      return styles.map(st=>({ speakerName: name, styleName: st.name, styleId: st.id }));
    });
    res.json({ ok:true, speakers:list });
  }catch(e){ res.status(500).json({ ok:false, error: errStr(e) }); }
});

// ---- フォーム ----
const storage = multer.diskStorage({
  destination: (req,file,cb)=> cb(null, UP_DIR),
  filename: (req,file,cb)=> cb(null, Date.now()+"_"+file.originalname.replace(/[^\w.\-]/g,"_"))
});
const fileFilter = (req,file,cb)=>{
  const ok = /^image\/(png|jpe?g|webp)$|^video\/(mp4|quicktime)$|^audio\/(mpeg|mp3|wav|aac)$/i.test(file.mimetype);
  cb(ok?null:new Error("unsupported file type"), ok);
};
const upload = multer({ storage, fileFilter, limits:{ fileSize: MAX_UPLOAD_MB*1024*1024 } });

function listAudioFiles(dir){
  try{ return fs.readdirSync(dir).filter(n=>/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(n)).sort(); }
  catch(_){ return []; }
}

app.get("/contest/4koma-lite", contestGuard, (req,res)=>{
  const sfx = listAudioFiles(SFX_DIR); const bgm = listAudioFiles(BGM_DIR);
  const tokenQs = PUBLIC_TOKEN?('?token='+PUBLIC_TOKEN):'';
  const css = `
:root{--bg:#0b1020;--card:#121833;--ink:#eaf0ff;--muted:#b9c1d9;--accent:#7c5cff;--accent2:#2ee6a6;--radius:18px;--shadow:0 10px 30px rgba(0,0,0,.35)}
html{scroll-behavior:smooth}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,'Hiragino Kaku Gothic ProN','Noto Sans JP','Yu Gothic',sans-serif;color:var(--ink);
  background:radial-gradient(1200px 600px at 10% -10%, rgba(124,92,255,.25), transparent 60%),
             radial-gradient(1000px 500px at 90% 0%, rgba(46,230,166,.15), transparent 55%),
             var(--bg);line-height:1.6}
.container{max-width:1040px;margin:0 auto;padding:24px}
.card{background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.07);border-radius:var(--radius);box-shadow:var(--shadow)}
.pad{padding:1.5rem}
.grid{display:grid;grid-template-columns:1fr;gap:1rem}
@media(min-width:860px){.grid{grid-template-columns:repeat(2,1fr)}}
h1{font-size:clamp(1.6rem,2vw+1.2rem,2.4rem);margin:.2rem 0 1rem}
.muted{color:var(--muted)}
label{font-weight:600;font-size:.95rem}
.row{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:1rem;margin:.6rem 0}
.inline{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap;justify-content:flex-start}
.cta{display:inline-block;padding:12px 18px;border-radius:999px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#0a0f1a;font-weight:700;text-decoration:none;box-shadow:var(--shadow);border:0;cursor:pointer}
.cta:hover{filter:brightness(1.08)}
input:not([type]),input[type=text],input[type=number],input[type=url],input[type=file],select,textarea{width:100%;padding:.65rem .75rem;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.25);color:var(--ink)}
input[type=color]{padding:.25rem;height:42px}
audio{width:100%}
input[type=checkbox]{width:auto;height:auto;margin:0 .4rem 0 0;vertical-align:middle}
label.cb{display:inline-flex;align-items:center;gap:.5rem;font-weight:600}
.badge{display:inline-block;font-size:.75rem;padding:.15rem .5rem;border-radius:999px;background:rgba(124,92,255,.25);color:#d9d0ff;margin-left:.4rem}
  `;
  res.set("Content-Type","text/html; charset=utf-8");
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>4コマLITE v3</title>
  <style>${css}</style>
  <div class="container">
    <div class="card pad">
      <h1>4コマ動画ジェネレーター <span class="badge">v3</span></h1>
      <p class="muted">効果はフェード固定（0.2s）。背景色は全体設定で一括。<br>
      最低秒数 0 = パディングなし（尺は読み上げの長さで決まる）。話者はシーンごとに変更できます。</p>
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
          <div class="grid" style="margin-top:.6rem">
            <div>
              <label>話者（全体の既定）</label>
              <select id="voiceSel" name="voiceRef"><option value="">(読み込み中)…</option></select>
            </div>
            <div>
              <label>BGM（ローカル選択）</label>
              <select id="bgmSel" name="bgm_file">
                <option value="">（なし）</option>
                ${bgm.map(f=>`<option value="${f}">${f}</option>`).join("")}
              </select>
              <audio id="bgmAud" controls preload="none" style="margin-top:.4rem"></audio>
            </div>
          </div>
          <div class="grid" style="margin-top:.6rem">
            <div>
              <label>各シーンの最低秒数（0 = パディングなし）</label>
              <input type="number" name="durationMin" value="${DEFAULT_MIN_DUR}" min="0" step="0.5" style="max-width:160px">
            </div>
            <div>
              <label>A/B ラベル（任意・記録用）</label>
              <input name="variant" placeholder="例: A_問いかけ型">
            </div>
          </div>
        </section>
        ${[1,2,3,4].map(i=>`
        <section class="row">
          <h3 style="margin:.2rem 0 .6rem">シーン${i}</h3>
          <div class="grid">
            <div>
              <label>コンテンツ（画像 / 動画）</label>
              <input type="file" name="content_${i}" accept="image/*,video/mp4,video/quicktime">
              <div class="inline" style="margin-top:.4rem">
                <input name="contentUrl_${i}" placeholder="URL指定（任意）">
              </div>
              <div class="inline" style="margin-top:.4rem">
                <label class="cb"><input type="checkbox" name="muteSrcAudio_${i}" value="1">元動画の音源をオフにする</label>
              </div>
            </div>
            <div>
              <label>効果音（SFX）</label>
              <select id="sfxSel_${i}" name="sfx_${i}">
                <option value="">（なし）</option>
                ${sfx.map(f=>`<option value="${f}">${f}</option>`).join("")}
              </select>
              <audio id="sfxAud_${i}" controls preload="none" style="margin-top:.4rem"></audio>
              <input type="hidden" name="sfxVolume_${i}" value="1">
            </div>
          </div>
          <div class="grid" style="margin-top:.6rem">
            <div>
              <label>上部テキスト</label>
              <input name="top_${i}" placeholder="上のテキスト">
              <label class="cb" style="margin-top:.4rem"><input type="checkbox" name="speak_top_${i}" checked>読み上げ</label>
              <select class="voiceOpt" name="voice_top_${i}" style="margin-top:.4rem"><option value="">（全体設定を使う）</option></select>
            </div>
            <div>
              <label>下部テキスト</label>
              <input name="bottom_${i}" placeholder="下のテキスト">
              <label class="cb" style="margin-top:.4rem"><input type="checkbox" name="speak_bottom_${i}">読み上げ</label>
              <select class="voiceOpt" name="voice_bottom_${i}" style="margin-top:.4rem"><option value="">（全体設定を使う）</option></select>
            </div>
          </div>
        </section>`).join("")}
        <div class="inline" style="justify-content:flex-end; margin-top:.6rem">
          <button class="cta" type="submit">送信（生成をキューに追加）</button>
        </div>
      </form>
    </div>
  </div>
  <script>
    var token='${PUBLIC_TOKEN}';
    var pick=document.getElementById('bgColorPick'), txt=document.getElementById('bgColorText');
    pick.addEventListener('input',function(){ txt.value=pick.value; });
    txt.addEventListener('input',function(){ if(/^#?[0-9a-fA-F]{6}$/.test(txt.value)){ txt.value=txt.value.charAt(0)==='#'?txt.value:('#'+txt.value); pick.value=txt.value; }});

    function bindPreview(selId,audId,base){
      var sel=document.getElementById(selId), aud=document.getElementById(audId);
      if(!sel||!aud) return;
      sel.addEventListener('change',function(){ var v=sel.value; aud.src = v? (base + encodeURIComponent(v)) : ''; aud.pause(); if(v){ aud.load(); } });
    }
    bindPreview('bgmSel','bgmAud','/media/bgm/');
    ${[1,2,3,4].map(i=>`bindPreview('sfxSel_${i}','sfxAud_${i}','/media/sfx/');`).join('')}

    // 話者一覧（VOICEVOX + COEIROINK）を取得して全 select に反映
    (function(){
      fetch('/api/voices'+(token?('?token='+token):''))
        .then(function(r){ return r.json(); })
        .then(function(j){
          var main=document.getElementById('voiceSel');
          main.innerHTML='';
          if(!(j.ok && j.voices && j.voices.length)){
            main.innerHTML='<option value="2">デフォルト(2)</option>';
            return;
          }
          j.voices.forEach(function(v){
            var label=(v.preset?'★ ':'')+v.label+' ['+v.engine+']';
            var o=document.createElement('option'); o.value=v.ref; o.textContent=label;
            main.appendChild(o);
            var per=document.createElement('option'); per.value=v.ref; per.textContent=label;
            document.querySelectorAll('.voiceOpt').forEach(function(sel){
              sel.appendChild(per.cloneNode(true));
            });
          });
        })
        .catch(function(){
          document.getElementById('voiceSel').innerHTML='<option value="2">デフォルト(2)</option>';
        });
    })();
  </script>`);
});

app.post("/contest/4koma-lite", contestGuard, upload.any(), async (req,res)=>{
  try{
    const F={}; (req.files||[]).forEach(f=>{ F[f.fieldname]=f.path; });
    const B=req.body||{}; const scenes=[];
    const dMin = (B.durationMin !== undefined && B.durationMin !== "") ? Number(B.durationMin) : DEFAULT_MIN_DUR;

    for (let i=1;i<=4;i++){
      const top=B['top_'+i]||''; const bottom=B['bottom_'+i]||'';
      const cfile=F['content_'+i]||''; const curl=B['contentUrl_'+i]||''; const src=cfile||curl;
      const ctype = src && /\.(mp4|mov)$/i.test(src) ? 'video' : (src? 'image' : '');
      const muteSrc = !!B['muteSrcAudio_'+i];

      const sfxName = B['sfx_'+i]||''; let sfxObj=null;
      if (sfxName){
        try{
          const fsPath = safeJoin(SFX_DIR, sfxName);
          if (fs.existsSync(fsPath)) sfxObj = { fsPath, url:'/media/sfx/'+encodeURIComponent(sfxName), volume:1.0 };
        }catch(_){}
      }

      if (!top && !bottom && !src) continue;
      const vTop = B['voice_top_'+i]||'';
      const vBot = B['voice_bottom_'+i]||'';
      scenes.push({
        durationMin: dMin,
        content: src? { type:ctype||'image', url:src, fit:'contain', effect:{name:'fade'} } : undefined,
        topText: top? { text:top, speak: !!B['speak_top_'+i], voice: vTop||undefined, effect:{name:'fade'} } : undefined,
        bottomText: bottom? { text:bottom, speak: !!B['speak_bottom_'+i], voice: vBot||undefined, effect:{name:'fade'} } : undefined,
        useSrcAudio: (!muteSrc) && ctype==='video',
        sfx: sfxObj
      });
    }

    const bgmFile = B['bgm_file']||''; let bgmObj={};
    if (bgmFile){
      try{
        const fsPath = safeJoin(BGM_DIR, bgmFile);
        if (fs.existsSync(fsPath)) bgmObj = { fsPath, url:'/media/bgm/'+encodeURIComponent(bgmFile), volume:0.15, loop:true };
      }catch(_){}
    }

    const cfg={
      meta:{ title:B.title||'', description:B.description||'', variant:B.variant||'' },
      video:{ width:Number(B.width||720), height:Number(B.height||1280), fps:Number(B.fps||25), bgColorDefault:B.bgColorDefault||'#212121' },
      voice:{ ref: (B.voiceRef !== undefined && B.voiceRef !== "") ? B.voiceRef : Number(B.speakerId||2) },
      bgm: bgmObj,
      scenes
    };

    const id = enqueue(cfg);
    res.set("Content-Type","text/html; charset=utf-8");
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>受付完了</title>
      <body style="background:#0b1020;color:#eaf0ff;font-family:sans-serif">
      <h2 style="text-align:center;margin-top:2rem">受付しました</h2>
      <p style="text-align:center;color:#b9c1d9">ジョブID: <code>${id}</code></p>
      <div id="st" style="text-align:center;color:#b9c1d9">処理待ち...</div>
      <div id="cr" style="text-align:center;color:#7c8bb9;font-size:.85rem;margin-top:1rem"></div>
      <script>
        function poll(){
          fetch('/api/jobs/${id}${PUBLIC_TOKEN?('?token='+PUBLIC_TOKEN):''}')
            .then(function(r){ return r.json(); })
            .then(function(j){
              var st=document.getElementById('st');
              if(!j.ok){ st.textContent='エラー: '+(j.error||'unknown'); return; }
              if(j.status==='done'){
                st.innerHTML = '完了: <a style="color:#2ee6a6" href="'+ j.result.url +'">ダウンロード/再生</a>';
                if(j.result.creditLine){
                  document.getElementById('cr').textContent='要クレジット表記: '+j.result.creditLine;
                }
                return;
              }
              if(j.status==='error'){ st.textContent='失敗: '+(j.error||'unknown'); return; }
              st.textContent=(j.status||'')+'...';
              setTimeout(poll, 4000);
            })
            .catch(function(){
              document.getElementById('st').textContent='通信エラー';
              setTimeout(poll, 5000);
            });
        }
        poll();
      </script>`);
  }catch(e){ res.status(400).send(String(e && e.message || e)); }
});

// ---- ジョブAPI ----
const q=[]; let runningCount=0; const jobs=new Map();
app.post("/api/jobs", auth, bodyParser.json({limit:"10mb"}), (req,res)=>{
  try{
    if (q.length + runningCount >= MAX_QUEUE) return res.status(429).json({ ok:false, error:"queue full" });
    const id = enqueue(req.body||{});
    res.json({ ok:true, jobId:id });
  }catch(e){ res.status(400).json({ ok:false, error: errStr(e) }); }
});
app.get("/api/jobs/:id", (req,res)=>{
  if (API_KEY) {
    const k = (req.headers["x-api-key"]||"").toString();
    const t = ((req.query && req.query.token) || "").toString();
    if (k !== API_KEY && !(PUBLIC_TOKEN && t === PUBLIC_TOKEN)) {
      return res.status(401).json({ ok:false, error:"unauthorized" });
    }
  }
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ ok:false, error:"not found" });
  res.json({ ok:true, status:j.status, result:j.result, error:j.error });
});

// ---- 後方互換（同期） ----
app.post("/api/render", auth, bodyParser.json({limit:"10mb"}), bodyParser.urlencoded({ extended:true, limit:"10mb" }), async (req,res)=>{
  try{
    const cfg = normalizeV1(req.body||{});
    const r = await renderFromConfig(cfg);
    const file = path.basename(r.file);
    res.json({ ok:true, file, url:"/output/"+file, creditLine: r.meta.creditLine });
  }catch(e){ res.status(400).json({ ok:false, error: errStr(e) }); }
});

// ====== ジョブキュー ======
function enqueue(payload){
  const cfg = payload && payload.scenes ? payload : normalizeV1(payload||{});
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2,8);
  jobs.set(id, { status:"queued", payload: cfg });
  q.push(id); pump();
  return id;
}
async function workerOnce(id){
  const j=jobs.get(id); if (!j) return;
  j.status="working";
  try{
    const r = await renderFromConfig(j.payload);
    const file = path.basename(r.file);
    j.status="done";
    j.result={ file, url:"/output/"+file, creditLine: r.meta.creditLine, elapsedSec: r.meta.elapsedSec };
  }catch(e){ j.status="error"; j.error=errStr(e); console.error("[job "+id+"] failed:", errStr(e)); }
}
async function pump(){
  if (runningCount>=CONCURRENCY || q.length===0) return;
  const id=q.shift(); runningCount++;
  workerOnce(id).then(()=>{ runningCount--; setImmediate(pump); })
               .catch(()=>{ runningCount--; setImmediate(pump); });
}

// ====== 起動 ======
const appServer = http.createServer(app);
appServer.listen(PORT, ()=>{
  console.log("Re:NEMA v3 server listening on :"+PORT);
  console.log("  voicevox : " + VOICEVOX_BASE);
  console.log("  coeiroink: " + COEIROINK_BASE);
  console.log("  presets  : " + Object.keys(VOICES).join(", "));
  console.log("  minDur   : " + DEFAULT_MIN_DUR + "s / maxScenes: " + MAX_SCENES);
});
