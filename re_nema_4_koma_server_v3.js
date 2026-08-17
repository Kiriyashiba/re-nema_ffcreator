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
/*
 検証用の使い捨てトークン。未設定なら完全に無効（既定値は持たない）。
 API_KEY と PUBLIC_TOKEN の両方の代わりに使えるが、本番の資格情報とは独立しているので
 漏れた場合はこの1行を消して再起動するだけで失効する。
 検証が終わったら .env から削除すること。有効な間は /health に enabled と出る。
*/
const TEST_TOKEN = ENV.TEST_TOKEN || "";
function isTestToken(v){ return !!TEST_TOKEN && String(v||"") === TEST_TOKEN; }

const VOICEVOX_BASE  = ENV.VOICEVOX_BASE  || "http://127.0.0.1:50021";
const COEIROINK_BASE = ENV.COEIROINK_BASE || "http://127.0.0.1:50032";

const VOICEVOX_SPEED = Number(ENV.VOICEVOX_SPEED || 1.0);
const VOICEVOX_PAUSE = (ENV.VOICEVOX_PAUSE ? Number(ENV.VOICEVOX_PAUSE) : null);

const FONT_PATH  = ENV.FONT_PATH  || "/root/re-nema_ffcreator/fonts/NotoSansJP-Regular.ttf";
const TEXT_COLOR = ENV.TEXT_COLOR || "#ffffff";
// 本文テキストの文字サイズ範囲。上限から始めて、収まるまで縮める
const TEXT_PT_MAX = Number(ENV.TEXT_PT_MAX || 44);
const TEXT_PT_MIN = Number(ENV.TEXT_PT_MIN || 20);
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

// ---- 音量設計 ----
// amix は既定（normalize=1）で各入力を 1/入力数 に落とす。つまり BGM や SFX を
// 乗せた時点で読み上げ音声が約6dB下がる。v3 では normalize=0 に固定し、
// 各入力の音量を volume フィルタで明示する。合算で 0dBFS を超えうるので
// 最後に alimiter を通す（超えない限り音は変えない）。
const VOICE_VOLUME   = Number(ENV.VOICE_VOLUME   || 1.0);   // 読み上げ音声の基準
const SRC_AUDIO_VOL  = Number(ENV.SRC_AUDIO_VOL  || 0);     // content.srcAudioVolume の既定
const MIX_LIMIT      = Number(ENV.MIX_LIMIT      || 0.95);  // alimiter の上限（0で無効）
function clampVol(v, dflt){
  const n = Number(v);
  if (!isFinite(n) || n < 0) return dflt;
  return Math.min(n, 4);
}
// normalize=0 で混ぜ、必要ならリミッタを通すまでの後段フィルタ
function mixTail(inLabels, outLabel){
  const n = inLabels.length;
  const mixed = MIX_LIMIT > 0 ? "[mx]" : `[${outLabel}]`;
  let f = `${inLabels.map(l=>`[${l}]`).join("")}amix=inputs=${n}:duration=first:normalize=0${mixed}`;
  if (MIX_LIMIT > 0) f += `;[mx]alimiter=limit=${MIX_LIMIT}:level=disabled[${outLabel}]`;
  return f;
}

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

/*
 日本語の折り返し。旧版は「全角も半角も1文字」として固定文字数で切っていたため、
   ・半角（英数字）が混じると1行が短くなりすぎる
   ・句読点や括弧の切れ目を無視して語の途中で割れる（例:「伸びる投／稿には」）
   ・最終行だけ極端に短い、行長のばらつきが出る
 という3点が出ていた。ここでは
   ①全角=1 / 半角=0.5 で幅を数える
   ②英数字の連なりは分割しない
   ③行頭・行末の禁則処理
   ④行数を先に決めて「1行あたりの目標幅」で均等に割る
 の4つを行う。maxUnits は全角換算の1行あたり上限。
*/
const KINSOKU_HEAD = "、。，．,.）〕〉》」』】｝!?！？：；・ー〜～…‥ゝゞヽヾっゃゅょぁぃぅぇぉッャュョァィゥェォ％%℃°";
const KINSOKU_TAIL = "（〔〈《「『【｛￥＄＃@＠";

function charUnits(ch){
  // 半角英数・記号・半角カナは 0.5 幅として数える
  return /[ -~｡-ﾟ]/.test(ch) ? 0.5 : 1;
}
function strUnits(s){ let w = 0; for (const ch of s) w += charUnits(ch); return w; }

// 分割してはいけない塊（英数字とその内部の . - _ / :）を1トークンにまとめる
function tokenizeForWrap(line){
  const tokens = [];
  const chars = [...line];
  for (let i = 0; i < chars.length; i++){
    if (/[A-Za-z0-9]/.test(chars[i])){
      let t = chars[i];
      while (i + 1 < chars.length &&
             (/[A-Za-z0-9]/.test(chars[i+1]) ||
              (/[.\-_/:]/.test(chars[i+1]) && i + 2 < chars.length && /[A-Za-z0-9]/.test(chars[i+2])))){
        t += chars[++i];
      }
      tokens.push(t);
    } else {
      tokens.push(chars[i]);
    }
  }
  return tokens;
}

/*
 「ここで折ってよいか」の点数。形態素解析は入れない（辞書もCPUも要る）ので、
 文字種の並びだけで判断する。句読点や閉じ括弧の直後は良い切れ目、
 漢字＋ひらがな（送り仮名）や熟語・カタカナ語の途中は悪い切れ目。
*/
const isHira  = ch => /[ぁ-ゟ]/.test(ch);
const isKata  = ch => /[゠-ヿｦ-ﾟ]/.test(ch);
const isKanji = ch => /[一-鿿々〆]/.test(ch);
function breakScore(prevTok, nextTok){
  const p = prevTok[prevTok.length-1], n = nextTok[0];
  let s = 0;
  if (/[。、！？!?，,．.…]/.test(p))       s += 12;  // 句読点のあと
  if (/[」』）〉》】〕｝]/.test(p))          s += 10;  // 閉じ括弧のあと
  if (/[「『（〈《【〔｛]/.test(n))          s += 8;   // 開き括弧の前
  if (isHira(p) && !isHira(n))            s += 6;   // 助詞・活用語尾のあと
  if (isKanji(p) && isHira(n))            s -= 10;  // 送り仮名を割る（伸／びる）
  if (isKanji(p) && isKanji(n))           s -= 5;   // 熟語を割る（投／稿）
  if (isKata(p)  && isKata(n))            s -= 10;  // カタカナ語を割る
  if (isHira(p) && isHira(n))             s -= 8;   // 「です」「ます」等を割らない
  return s;
}

function softWrapText(text, maxCharsPerLine){
  const maxUnits = Math.max(2, Number(maxCharsPerLine) || 2);
  const out = [];

  for (const raw of String(text||"").replace(/\r/g,"").split("\n")){
    if (!raw){ out.push(""); continue; }
    const tokens = tokenizeForWrap(raw);
    const total = strUnits(raw);

    // 行数を先に決め、その行数で均等になる幅を狙う。
    // 上限いっぱいまで詰めると最終行だけ極端に短くなるため。
    const lineCount = Math.max(1, Math.ceil(total / maxUnits));
    const target = Math.min(maxUnits, total / lineCount + 0.5);

    // 目標幅の前後で「切ってよさそうな位置」を探し、最も点数の高いところで折る。
    // 候補が無ければ目標幅で機械的に折る。
    const lines = [];
    let s = 0;
    while (s < tokens.length){
      let w = 0, hardEnd = s;
      while (hardEnd < tokens.length && w + strUnits(tokens[hardEnd]) <= maxUnits){
        w += strUnits(tokens[hardEnd]); hardEnd++;
      }
      if (hardEnd === s) hardEnd = s + 1; // 1トークンで上限を超える場合は諦めて1つ入れる

      let best = hardEnd, bestScore = -Infinity, acc = 0;
      for (let k = s; k < hardEnd; k++){
        acc += strUnits(tokens[k]);
        if (k + 1 >= tokens.length) break;              // 行末＝文末なら探索不要
        if (acc < target * 0.7) continue;               // 短すぎる行は作らない
        // 目標幅から離れるほど強く減点する。切れ目の良さで動かせるのは数文字ぶん。
        const sc = breakScore(tokens[k], tokens[k+1]) - Math.abs(acc - target) * 3;
        if (sc > bestScore){ bestScore = sc; best = k + 1; }
      }
      lines.push(tokens.slice(s, best).join(""));
      s = best;
    }

    // 最終行が「。」だけ、のような孤立を潰す。前の行に入れば入れる、
    // 入らなければ前の行から1文字だけ送る。
    while (lines.length > 1 && strUnits(lines[lines.length-1]) <= 2.5){
      const tail = lines[lines.length-1], prev = lines[lines.length-2];
      if (strUnits(prev) + strUnits(tail) <= maxUnits){
        lines.splice(lines.length-2, 2, prev + tail);
        break;
      }
      lines[lines.length-2] = prev.slice(0, -1);
      lines[lines.length-1] = prev[prev.length-1] + tail;
      if (strUnits(lines[lines.length-1]) > 2.5) break;
    }

    // 禁則処理: 行頭に来てはいけない文字は前の行へ、
    // 行末に来てはいけない文字は次の行へ送る（上限を超える場合はあきらめる）
    for (let i = 1; i < lines.length; i++){
      let guard = 0;
      while (lines[i] && KINSOKU_HEAD.includes(lines[i][0]) && guard++ < 4){
        if (strUnits(lines[i-1]) + charUnits(lines[i][0]) > maxUnits) break;
        lines[i-1] += lines[i][0];
        lines[i] = lines[i].slice(1);
      }
      if (!lines[i]){ lines.splice(i,1); i--; }
    }
    for (let i = 0; i < lines.length - 1; i++){
      let guard = 0;
      while (lines[i] && KINSOKU_TAIL.includes(lines[i][lines[i].length-1]) && guard++ < 4){
        if (strUnits(lines[i+1]) + charUnits(lines[i][lines[i].length-1]) > maxUnits) break;
        lines[i+1] = lines[i][lines[i].length-1] + lines[i+1];
        lines[i] = lines[i].slice(0, -1);
      }
    }
    for (const l of lines) if (l) out.push(l);
  }
  return out.join("\n");
}

// ====== テキストPNG（自動折り返し + フィット） ======
async function textCaptionToPng(text, width, boxH, align, outPath, colorHex){
  const padW = Math.max(40, Math.floor(width * 0.08));
  const tgtW = Math.max(50, width - padW);
  const tgtH = Math.max(60, boxH - 20);
  const gravity = align === "top" ? "north" : (align === "bottom" ? "south" : "center");
  const esc = (s)=> String(s||"").replace(/\\/g,"\\\\").replace(/"/g,'\\"');
  const tmp = outPath + ".try.png";
  let pt = TEXT_PT_MAX;

  for (let tries = 0; tries < 12; tries++){
    /*
     全角1文字の送り幅はほぼ pt（1em）。旧版は 0.58 を掛けていたため
     1行あたりの上限を実際の1.7倍ほどに見積もっており、softWrapText がほとんど働かず
     ImageMagick の caption: 側が幅で機械的に折り返していた。
     これが「語の途中で割れる」原因。全角換算の幅で見積もれば自前の折り返しが効く。
    */
    const maxUnits = Math.max(4, (tgtW / pt) * 0.98);
    const wrapped = softWrapText(text, maxUnits);

    /*
     ★ 高さを指定しないこと（`-size ${tgtW}x`）。
     `-size 幅x高さ` を付けると、テキストが収まっていなくてもキャンバスは必ずその寸法に
     なるため、identify が常に指定値を返して縮小判定が1回目で成立してしまう。
     これが「自動調整が効かず、はみ出した分が切れる」原因だった。
     幅だけ指定すれば高さは実際の行数ぶん伸びるので、正しく測れる。
    */
    const cmd = `convert -background none -fill "${colorHex||TEXT_COLOR}" ` +
                `-font "${FONT_PATH}" -pointsize ${pt} -gravity center ` +
                `-interline-spacing 4 -size ${tgtW}x caption:"${esc(wrapped)}" "${tmp}"`;
    await exec(cmd);

    const id = await exec(`identify -format "%w %h" "${tmp}"`);
    const parts = (id.stdout||"").trim().split(/\s+/).map(Number);
    const tw = parts[0]||0, th = parts[1]||0;

    if (th > 0 && th <= tgtH && tw <= tgtW) {
      await exec(`convert "${tmp}" -background none -gravity ${gravity} -extent ${width}x${boxH} "${outPath}"`);
      try{ fs.unlinkSync(tmp); }catch(_){}
      return outPath;
    }
    if (pt <= TEXT_PT_MIN) break;
    pt = Math.max(TEXT_PT_MIN, Math.floor(pt * 0.88));
  }

  // 最小サイズでも収まらない場合。切れるよりは縮小して全文を残す
  await exec(`convert "${tmp}" -background none -resize ${tgtW}x${tgtH} -gravity ${gravity} -extent ${width}x${boxH} "${outPath}"`);
  try{ fs.unlinkSync(tmp); }catch(_){}
  return outPath;
}

// ====== クレジット帯（右下・小さめ） ======
/*
 ライセンス表記用。COEIROINK は「クレジットをすること（例:「COEIROINK:<合成音声名>」）」を
 規約で義務づけているため、任意機能ではなく既定で焼き込む。
 動画全体に後からオーバーレイすると addBgm の -c:v copy が使えず全編再エンコードになるので、
 各シーンのキャンバス生成時に合成する（追加コストはほぼゼロ）。
*/
function creditStripHeight(H){ return Math.max(22, Math.floor(H * 0.028)); }

async function creditStripPng(text, W, H, outPath){
  const stripH = creditStripHeight(H);
  const pt = Math.max(13, Math.floor(stripH * 0.58));
  const esc = (s)=> String(s||"").replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/%/g,"%%");
  const margin = Math.max(12, Math.floor(W * 0.03));
  const t = esc(text);
  // 背景が明るくても読めるよう、黒の影を1px ずらして重ねる
  await exec(
    `convert -size ${W}x${stripH} xc:none -font "${FONT_PATH}" -pointsize ${pt} -gravity east ` +
    `-fill "#000000" -annotate +${margin - 1}+1 "${t}" ` +
    `-fill "#d8d8d8" -annotate +${margin}+0 "${t}" "${outPath}"`
  );
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

  // normalize=0。声は VOICE_VOLUME のまま、SFX は sfx.volume で明示的に決める
  const filter =
    `[0:a]volume=${VOICE_VOLUME},asetpts=PTS-STARTPTS[v];`+
    `[1:a]volume=${vol},atrim=end=${fmtSec(D)},asetpts=PTS-STARTPTS[s];`+
    mixTail(["v","s"], "a");
  const cmd = `ffmpeg -y -i "${voiceWav}" -i "${sfxPath}" -filter_complex "${filter}" -map "[a]" -ar ${SAMPLE_RATE} -ac 2 -f wav "${outPath}"`;
  await exec(cmd);
  return outPath;
}

// ====== 画像シーン（上下文字を事前合成） ======
async function composeCanvasPng(W,H,bgColor,contentUrl,fit,topText,bottomText,creditText){
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
  // クレジットを焼く場合、下部テキストをその分だけ持ち上げて重なりを避ける
  const lift = creditText ? creditStripHeight(H) : 0;
  if (bottomText && bottomText.text){
    const bpng=path.join(TMP_DIR,`tbot_${stamp()}.png`);
    await textCaptionToPng(bottomText.text,W,boxH,"bottom",bpng,TEXT_COLOR);
    await exec(`composite -gravity south -geometry +0+${lift} "${bpng}" "${canvas}" "${canvas}"`);
  }
  if (creditText){
    const cpng=path.join(TMP_DIR,`credit_${stamp()}.png`);
    await creditStripPng(creditText, W, H, cpng);
    await exec(`composite -gravity south "${cpng}" "${canvas}" "${canvas}"`);
  }
  return canvas;
}

// v3: duration は小数のまま
async function renderImageSilent(outMp4, W,H,FPS, scene, duration, bgDefault, creditText){
  const contentUrl = scene.content && scene.content.url;
  const fit = (scene.content && scene.content.fit) || 'contain';
  const canvas = await composeCanvasPng(W,H,bgDefault,contentUrl,fit,scene.topText, scene.bottomText, creditText);
  await exec(`ffmpeg -y -loop 1 -i "${canvas}" -t ${fmtSec(duration)} -r ${FPS} -vf "format=yuv420p,setpts=PTS-STARTPTS" -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.1 "${outMp4}"`);
  return outMp4;
}

// ====== 動画シーン ======
async function renderVideoSilent(outMp4, W,H,FPS, scene, duration, creditText){
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
  const lift = creditText ? creditStripHeight(H) : 0;
  if (scene.bottomText && scene.bottomText.text){
    const bpng=path.join(TMP_DIR,`tbot_${stamp()}.png`);
    await textCaptionToPng(scene.bottomText.text,W,boxH,"bottom",bpng,TEXT_COLOR);
    inputs.push(`-loop 1 -t ${D} -i "${bpng}"`);
    idx++; filter+=`;${last}[${idx}:v]overlay=x=(W-w)/2:y=H-h-${40 + lift}:format=auto[v${idx}]`.replace(/W/g,String(W)).replace(/H/g,String(H)); last=`[v${idx}]`;
  }
  if (creditText){
    const cpng=path.join(TMP_DIR,`credit_${stamp()}.png`);
    await creditStripPng(creditText, W, H, cpng);
    inputs.push(`-loop 1 -t ${D} -i "${cpng}"`);
    idx++; filter+=`;${last}[${idx}:v]overlay=x=0:y=H-h:format=auto[v${idx}]`.replace(/H/g,String(H)); last=`[v${idx}]`;
  }

  const cmd = `ffmpeg -y ${inputs.join(' ')} -filter_complex "${filter}" -map "${last}" -an -r ${FPS} -pix_fmt yuv420p -c:v libx264 -profile:v baseline -level 3.1 -t ${D} "${outMp4}"`;
  await exec(cmd);
  return { out: outMp4, vLocal };
}

// ====== シーン音声 ======
/*
 シーンの話者を決める。クレジットは描画より先に必要（各シーンのキャンバスに焼き込むため）で、
 renderFromConfig の事前パスと buildSceneAudio が同じ結論を出す必要があるので関数に切り出す。
*/
function sceneVoices(scene, voiceDefault){
  const pick = (t)=> t && (t.voice !== undefined ? t.voice : t.speakerId);
  return {
    vTop: resolveVoice(pick(scene.topText), voiceDefault),
    vBot: resolveVoice(pick(scene.bottomText), voiceDefault)
  };
}

async function buildSceneAudio(scene, voiceDefault, FPS, sceneIndex){
  const topT = scene.topText && scene.topText.text ? String(scene.topText.text) : "";
  const botT = scene.bottomText && scene.bottomText.text ? String(scene.bottomText.text) : "";
  const spTop = scene.topText && !!scene.topText.speak;
  const spBot = scene.bottomText && !!scene.bottomText.speak;

  // v3: 話者はシーン・位置単位で指定可能。未指定なら全体設定にフォールバック。
  //     v1 の scene.*.speakerId（整数）も resolveVoice が受理する。
  const { vTop, vBot } = sceneVoices(scene, voiceDefault);

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

// bgm.file / sfx.file（sounds/ 配下のファイル名）を fsPath に解決する。
// safeJoin がディレクトリ外への脱出を防ぐ。見つからない場合は黙って無指定扱い。
function resolveMediaRef(dir, obj){
  if (!obj || obj.fsPath || !obj.file) return obj;
  try{
    const p = safeJoin(dir, obj.file);
    if (fs.existsSync(p)) obj.fsPath = p;
    else console.warn(`[media] ${path.basename(dir)}/${obj.file} が見つかりません。無指定として続行します`);
  }catch(_){ console.warn(`[media] 不正なファイル名: ${obj.file}`); }
  return obj;
}

// 元動画音声の音量を決める。v2 の content.srcAudioVolume を正とし、
// 無い場合だけ v1 の useSrcAudio（真偽値）を見る。どちらも無ければ SRC_AUDIO_VOL（既定0＝無音）
function srcAudioVolumeOf(scene){
  const c = scene && scene.content;
  if (c && c.srcAudioVolume !== undefined && c.srcAudioVolume !== null && c.srcAudioVolume !== "") {
    return clampVol(c.srcAudioVolume, SRC_AUDIO_VOL);
  }
  if (scene && scene.useSrcAudio !== undefined) return scene.useSrcAudio ? 1.0 : 0;
  return SRC_AUDIO_VOL;
}

// ====== 遷移効果 ======
/*
 LLM には遷移名を選ばせず meta.tone（news/story/comedy）だけ選ばせ、
 サーバー側のこの表で遷移に変換する（DECISIONS: 語彙だけ選ばせ実体は表に持つ）。
 scene.transition が明示されていればそれを優先し、未知の値は黙って fade に落とす。

 cut/fade/zoom/slide は「シーン内で完結する」効果なので、既存の1パス
 （muxVideoAudio）にフィルタを足すだけで済む。パス数もメモリも増えない。
 dissolve だけは2シーンにまたがるため連結段の構造が変わる（下の concatVideos 参照）。
*/
const TONE_TRANSITIONS = { news: "cut", story: "fade", comedy: "slide" };
const TRANSITIONS = ["cut", "fade", "zoom", "slide", "dissolve"];
const XFADE_DUR = Number(ENV.XFADE_DUR || 0.4);   // dissolve の重なり秒数

function transitionOf(scene, tone){
  const t = scene && scene.transition;
  if (typeof t === "string" && TRANSITIONS.includes(t)) return t;
  const byTone = TONE_TRANSITIONS[String(tone||"").toLowerCase()];
  return byTone || "fade";
}

// シーン内で完結する効果。muxVideoAudio の映像フィルタを組み立てる
function transitionVideoFilter(kind, o){
  const { W, H, fps, fin, fout, dNum, fadeOutStart } = o;
  const fadeIn  = `fade=t=in:st=0:d=${fin}`;
  const fadeOut = `fade=t=out:st=${fadeOutStart}:d=${fout}`;
  // cut / dissolve はシーン間にフェードを入れないが、動画全体の先頭と末尾だけは
  // 入れる（fin/fout に0でない値が来た時だけ）。頭とお尻が唐突になるのを避けるため。
  const edgeOnly = [fin > 0 ? fadeIn : "", fout > 0 ? fadeOut : ""].filter(Boolean).join(",");
  const edgeChain = edgeOnly ? edgeOnly + "," : "";
  switch (kind){
    case "cut":
      return `[0:v]setpts=PTS-STARTPTS,${edgeChain}format=yuv420p[v]`;
    case "zoom":
      // ゆっくり寄る。先に拡大しておかないと zoompan が粗くなる
      return `[0:v]setpts=PTS-STARTPTS,scale=${Math.round(W*1.5)}:${Math.round(H*1.5)},`+
             `zoompan=z='min(1+0.0012*on,1.08)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},`+
             `${fadeIn},${fadeOut},format=yuv420p[v]`;
    case "slide": {
      // 右から差し込む。差し込み中はフェードインを掛けない
      const sd = fmtSec(Math.min(0.35, Math.max(0.12, dNum/3)));
      return `color=c=black:s=${W}x${H}:r=${fps}:d=${fmtSec(dNum)}[bg];`+
             `[0:v]setpts=PTS-STARTPTS[fg];`+
             `[bg][fg]overlay=x='if(lt(t,${sd}),(1-t/${sd})*${W},0)':y=0:shortest=1,`+
             `${fadeOut},format=yuv420p[v]`;
    }
    case "dissolve":  // 連結段で処理する。シーン単体では素通し（重なりは xfade が作る）
      return `[0:v]setpts=PTS-STARTPTS,${edgeChain}format=yuv420p[v]`;
    case "fade":
    default:
      return `[0:v]setpts=PTS-STARTPTS,${fadeIn},${fadeOut},format=yuv420p[v]`;
  }
}

// v3: duration は小数のまま。v1 はここでも Math.floor していた。
async function muxVideoAudio(outMp4, silentMp4, audioPath, duration, effect, srcAudio, srcVol){
  // 0 を明示的に渡せるようにする（cut / dissolve が「フェードなし」を指定するため）
  const fin = (effect && effect.in  !== undefined && effect.in  !== "") ? Number(effect.in)  : 0.2;
  const fout= (effect && effect.out !== undefined && effect.out !== "") ? Number(effect.out) : 0.2;
  const dNum = Number(duration) > 0.04 ? Number(duration) : 0.04;
  const D = fmtSec(dNum);
  const fadeOutStart = fmtSec(Math.max(0, dNum - fout));

  // 遷移効果の映像フィルタ。パスは増えない（既存の1パスに足すだけ）
  const vfilter = transitionVideoFilter((effect && effect.name) || "fade",
    { W: (effect && effect.W) || 720, H: (effect && effect.H) || 1280,
      fps: (effect && effect.fps) || 25, fin, fout, dNum, fadeOutStart });

  const sv = clampVol(srcVol, SRC_AUDIO_VOL);
  if (srcAudio && sv > 0){
    // 元動画の音声は srcAudioVolume で明示。読み上げは減衰させない（normalize=0）
    const filter = `${vfilter};`+
                   `[2:a]volume=${sv},atrim=end=${D},asetpts=PTS-STARTPTS[src];`+
                   `[1:a]volume=${VOICE_VOLUME},asetpts=PTS-STARTPTS[v1];`+
                   mixTail(["v1","src"], "amixed") + `;[amixed]apad[a]`;
    const cmd = `ffmpeg -y -stream_loop -1 -i "${silentMp4}" -i "${audioPath}" -i "${srcAudio}" -t ${D} -filter_complex "${filter}" -map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac "${outMp4}"`;
    await exec(cmd);
  } else {
    // 混ぜないので減衰は起きない。VOICE_VOLUME を変えている時だけ音量を掛ける
    // apad: dissolve のために尺を伸ばした分、音声が足りなくなるので無音で埋める
    const af = `-af "${VOICE_VOLUME !== 1 ? `volume=${VOICE_VOLUME},` : ""}apad" `;
    const cmd = `ffmpeg -y -stream_loop -1 -i "${silentMp4}" -i "${audioPath}" -t ${D} -filter_complex "${vfilter}" -map "[v]" -map 1:a ${af}-c:v libx264 -pix_fmt yuv420p -c:a aac "${outMp4}"`;
    await exec(cmd);
  }
  return outMp4;
}

async function concatVideos(files, finalOut, dissolveAt){
  const needXfade = Array.isArray(dissolveAt) && dissolveAt.some(Boolean);
  if (!needXfade){
    const list=path.join(TMP_DIR,`list_${stamp()}.txt`);
    fs.writeFileSync(list, files.map(f=>`file '${f.replace(/'/g,"'\\''")}'`).join("\n"), "utf8");
    await exec(`ffmpeg -y -safe 0 -f concat -i "${list}" -fflags +genpts -af aresample=async=1:first_pts=0 -c:v libx264 -preset veryfast -crf 22 -c:a aac -ar ${SAMPLE_RATE} "${finalOut}"`);
    return finalOut;
  }

  /*
   dissolve（xfade）は2シーンにまたがるため、全シーンを一度に開く形にすると
   同時デコード数がシーン数ぶん増える。2GB では持たせたくないので
   **2本ずつ逐次合成**する。同時に開くのは常に2本なのでメモリはシーン数によらず一定。
   代償として、合成のたびに「それまでの分」を再エンコードするので所要時間は増える。
   重なる 0.4 秒ぶんは、直前のシーンの尺を伸ばして無音・静止で確保してある
   （読み上げが食われないようにするため）。
  */
  let acc = files[0];
  let accDur = await readMediaDurationSec(acc);
  for (let i = 1; i < files.length; i++){
    const nextDur = await readMediaDurationSec(files[i]);
    const out = path.join(TMP_DIR, `cat_${i}_${stamp()}.mp4`);
    if (dissolveAt[i]){
      const off = fmtSec(Math.max(0, accDur - XFADE_DUR));
      const filter = `[0:v][1:v]xfade=transition=fade:duration=${fmtSec(XFADE_DUR)}:offset=${off}[v];`+
                     `[0:a][1:a]acrossfade=d=${fmtSec(XFADE_DUR)}[a]`;
      await exec(`ffmpeg -y -i "${acc}" -i "${files[i]}" -filter_complex "${filter}" -map "[v]" -map "[a]" `+
                 `-c:v libx264 -preset veryfast -crf 22 -c:a aac -ar ${SAMPLE_RATE} "${out}"`);
      accDur = accDur + nextDur - XFADE_DUR;
    } else {
      const list = path.join(TMP_DIR,`list_${i}_${stamp()}.txt`);
      fs.writeFileSync(list, [acc, files[i]].map(f=>`file '${f.replace(/'/g,"'\\''")}'`).join("\n"), "utf8");
      await exec(`ffmpeg -y -safe 0 -f concat -i "${list}" -fflags +genpts -af aresample=async=1:first_pts=0 `+
                 `-c:v libx264 -preset veryfast -crf 22 -c:a aac -ar ${SAMPLE_RATE} "${out}"`);
      accDur = accDur + nextDur;
    }
    acc = out;
  }
  fs.copyFileSync(acc, finalOut);
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

  // normalize=0。本編（読み上げ済み）はそのまま、BGM だけ bgm.volume まで落とす
  const primary =
    `ffmpeg -y -i "${finalIn}" ${loopOpt} -i "${bgPath}" ` +
    `-filter_complex "[1:a]volume=${vol}[bg];[0:a]anull[pg];` +
      mixTail(["pg","bg"], "a") + `" ` +
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
    credit: body.credit || { mode: "corner" },
    outro: body.outro || { enabled: false },
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

  const outs=[]; const scenes = (cfg.scenes || []).slice(0, MAX_SCENES);
  const allVoices = new Map();

  // スキーマ上の bgm.file / sfx.file（sounds/ 配下のファイル名）を実パスへ解決する。
  // フォーム経路では組み立て済みだが、JSON API 経路では未解決のまま addBgm に渡り
  // 「BGM を指定したのに無音」になっていた。
  resolveMediaRef(BGM_DIR, cfg.bgm);
  for (const sc of scenes) resolveMediaRef(SFX_DIR, sc && sc.sfx);

  // ---- 事前パス: 実際に読み上げる話者を確定し、クレジット文字列を組み立てる ----
  // 描画の前に必要（各シーンのキャンバスに焼き込むため）。
  const preVoices = new Map();
  for (const sc of scenes){
    const { vTop, vBot } = sceneVoices(sc, voiceDefault);
    if (sc.topText    && sc.topText.speak    && sc.topText.text)    preVoices.set(voiceKey(vTop), vTop);
    if (sc.bottomText && sc.bottomText.speak && sc.bottomText.text) preVoices.set(voiceKey(vBot), vBot);
  }
  const creditParts = [];
  for (const v of preVoices.values()) creditParts.push(await creditFor(v));

  const creditMode = (cfg.credit && cfg.credit.mode) || "corner";
  const creditLine = (cfg.credit && cfg.credit.text) || creditParts.join(" / ");
  const cornerCredit = (creditMode === "corner" || creditMode === "both") ? creditLine : "";
  if (creditMode === "none" && creditParts.length){
    console.warn("[credit] mode=none のため動画にクレジットが入りません。ライセンス上の義務を満たしているか確認してください");
  }

  // ---- 末尾の CTA / クレジットカード ----
  const outro = cfg.outro || {};
  const renderList = scenes.slice();
  if (outro.enabled){
    const d = Number(outro.duration) > 0 ? Number(outro.duration) : 3.0;
    renderList.push({
      __outro: true,
      durationMin: d,           // 読み上げが無いので尺はこれで決まる
      bgColorOverride: outro.bgColor || null,
      // クレジットは本文サイズではなく小さい帯で出す（下の credit 選択で付与）
      topText: outro.cta ? { text: String(outro.cta), speak:false } : undefined
    });
  }

  // ---- 遷移の解決 ----
  // LLM が選ぶのは meta.tone だけ。scene.transition が明示されていればそちらを優先。
  // outro カードは常に fade（CTAが飛び込んでくると落ち着かない）。
  const tone = (cfg.meta && cfg.meta.tone) || "";
  const transitions = renderList.map(sc => sc.__outro ? "fade" : transitionOf(sc, tone));
  // dissolveAt[i] = シーン i の「入り」を直前のシーンと重ねる
  const dissolveAt = transitions.map((t,i)=> i > 0 && t === "dissolve");

  for (let i=0;i<renderList.length;i++){
    const sc = renderList[i];
    const part = await buildSceneAudio(sc, voiceDefault, FPS, i);
    (part.usedVoices||[]).forEach(v=> allVoices.set(voiceKey(v), v));

    // v3: 小数のまま渡す（v1 は Math.floor で切り捨てていた）
    // 次のシーンが dissolve なら、重なる分だけ尺を伸ばして静止・無音で確保する。
    // これをしないと読み上げの末尾が次のシーンに食われる。
    const D = part.duration + (dissolveAt[i+1] ? XFADE_DUR : 0);

    // クレジットは常に小さい帯で出す（本文と同じ大きさにすると見切れる）。
    // outro カードには mode に関わらず必ず載せる（ライセンス表記のため）
    const credit = sc.__outro
      ? (creditMode !== "none" ? creditLine : "")
      : cornerCredit;

    const base = path.join(TMP_DIR,`base_${i+1}_${stamp()}.mp4`);
    let vLocalRef="";
    if (sc.content && sc.content.type==='video' && sc.content.url){
      const r = await renderVideoSilent(base, W,H,FPS, sc, D, credit); vLocalRef = r.vLocal;
    } else {
      await renderImageSilent(base, W,H,FPS, sc, D, (sc.bgColorOverride || bgDefault), credit);
    }

    // 元動画の音量。v2 は content.srcAudioVolume（0.0〜1.0）。
    // v1 の useSrcAudio（真偽値）は true=1.0 / false=0 として読み替える
    const srcVol = srcAudioVolumeOf(sc);
    const srcA = (srcVol > 0 && vLocalRef)
      ? (await (async()=>{ const out = path.join(TMP_DIR, `srca_${stamp()}.wav`); await exec(`ffmpeg -y -i "${vLocalRef}" -vn -t ${fmtSec(D)} -ar ${SAMPLE_RATE} -ac 2 -f wav "${out}"`); return out; })())
      : "";

    const withAudio = path.join(TMP_DIR,`scene_${i+1}_${stamp()}.mp4`);
    // フェード秒数は content.effect（フォーム経由）で上書きできる。効果の種類は遷移表で決まる
    const effIn = (sc.content && sc.content.effect) || {};
    const noInnerFade = transitions[i] === "cut" || transitions[i] === "dissolve";
    const isFirst = i === 0, isLast = i === renderList.length - 1;
    const eff = {
      name: transitions[i],
      in:  noInnerFade ? (isFirst ? 0.2 : 0) : effIn.in,
      out: noInnerFade ? (isLast  ? 0.2 : 0) : effIn.out,
      W, H, fps: FPS
    };
    await muxVideoAudio(withAudio, base, part.audio, D, eff, srcA, srcVol);
    outs.push(withAudio);
  }

  if (!outs.length) throw new Error("no renderable scenes");

  const finalOut = path.join(OUT_DIR, `video_${stamp()}.mp4`);
  await concatVideos(outs, finalOut, dissolveAt);
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
    tone: tone || null,                      // 実際に使った tone と、そこから決まった遷移
    transitions,
    credits,
    creditLine,                              // 実際に動画へ焼き込んだ文字列
    creditMode,
    creditBurnedIn: creditMode !== "none",
    outro: outro.enabled ? { cta: outro.cta || "", duration: Number(outro.duration)>0?Number(outro.duration):3.0 } : null,
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
function auth(req,res,next){ if (!API_KEY) return next(); const k = (req.headers["x-api-key"]||"").toString(); if (k === API_KEY) return next(); if (isTestToken(k)) return next(); return res.status(401).json({ ok:false, error:"unauthorized" }); }
function contestGuard(req,res,next){ if (!PUBLIC_TOKEN) return next(); const t = ((req.query && req.query.token) || (req.body && req.body.token) || "").toString(); if (t === PUBLIC_TOKEN) return next(); if (isTestToken(t)) return next(); return res.status(401).send("contest token required"); }
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
    presets: Object.keys(VOICES), defaultMinDur: DEFAULT_MIN_DUR, maxScenes: MAX_SCENES,
    testToken: TEST_TOKEN ? "enabled" : "disabled" });
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
          <div class="grid" style="margin-top:.6rem">
            <div>
              <label>クレジット表記</label>
              <select name="creditMode">
                <option value="corner">各シーンの右下に小さく（既定）</option>
                <option value="outro">末尾カードのみ</option>
                <option value="both">両方</option>
                <option value="none">入れない（規約違反の恐れ）</option>
              </select>
              <div class="muted" style="font-size:.8rem;margin-top:.3rem">使用した話者から自動生成されます</div>
            </div>
            <div>
              <label class="cb"><input type="checkbox" name="outroEnabled" value="1" checked>末尾にCTAカードを付ける</label>
              <input name="outroCta" placeholder="例: 台本ください→プロフィールへ" style="margin-top:.4rem">
              <div class="inline" style="margin-top:.4rem"><span class="muted" style="font-size:.85rem">長さ</span><input type="number" name="outroDuration" value="3" min="1" step="0.5" style="max-width:100px"><span class="muted" style="font-size:.85rem">秒</span></div>
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
        content: src? { type:ctype||'image', url:src, fit:'contain', effect:{name:'fade'},
                        srcAudioVolume: (ctype==='video' && !muteSrc) ? 1.0 : 0 } : undefined,
        topText: top? { text:top, speak: !!B['speak_top_'+i], voice: vTop||undefined, effect:{name:'fade'} } : undefined,
        bottomText: bottom? { text:bottom, speak: !!B['speak_bottom_'+i], voice: vBot||undefined, effect:{name:'fade'} } : undefined,
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
      credit:{ mode: B.creditMode || 'corner' },
      outro: B.outroEnabled
        ? { enabled:true, cta: B.outroCta||'', duration: Number(B.outroDuration||3) }
        : { enabled:false },
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
    if (k !== API_KEY && !(PUBLIC_TOKEN && t === PUBLIC_TOKEN) && !isTestToken(k) && !isTestToken(t)) {
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
  if (TEST_TOKEN) console.log("  ★ TEST_TOKEN が有効です。検証が終わったら .env から削除してください");
});
