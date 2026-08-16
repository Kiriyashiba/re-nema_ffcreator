"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const util = require("util");
const child = require("child_process");
const exec = util.promisify(child.exec);
const { FFCreator, FFScene, FFText, FFImage } = require("ffcreatorlite");

// =====================
// Config (env overridable)
// =====================
const ENV = process.env;
const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, "output");
const TMP_DIR = path.join(ROOT, "temp");

const DEFAULTS = {
  VOICEVOX_BASE: ENV.VOICEVOX_BASE || "http://127.0.0.1:50021",
  VOICEVOX_SPEAKER_ID: Number(ENV.VOICEVOX_SPEAKER_ID || 2),
  VIDEO_W: Number(ENV.VIDEO_W || 720),
  VIDEO_H: Number(ENV.VIDEO_H || 1280),
  VIDEO_FPS: Number(ENV.VIDEO_FPS || 25),
  VIDEO_BG: ENV.VIDEO_BG || "#303030",
  VIDEO_MARGIN: Number(ENV.VIDEO_MARGIN || 20),
  FONT_PATH: ENV.FONT_PATH || "fonts/NotoSansJP-Regular.ttf",
  FONT_COLOR: ENV.FONT_COLOR || "#ffffff",
  FONT_MAX: Number(ENV.FONT_MAX || 56),
  FONT_MIN: Number(ENV.FONT_MIN || 18),
  API_KEY: ENV.API_KEY || "",
  PORT: Number(ENV.PORT || 3000),
};

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
ensureDir(OUT_DIR); ensureDir(TMP_DIR);

// =====================
// Utils
// =====================
function stamp() {
  const d = new Date();
  function z(n){ return String(n).padStart(2, "0"); }
  return (
    d.getFullYear() + z(d.getMonth()+1) + z(d.getDate()) + "_" +
    z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds())
  );
}

function errStr(err){
  try {
    if (err && err.response && err.response.data) {
      if (typeof err.response.data === "string") return err.response.data;
      try { return JSON.stringify(err.response.data); } catch (_){ return String(err.response.data); }
    }
    if (err && err.message) return err.message;
    return String(err);
  } catch(e){ return "Unknown error"; }
}

async function checkCmd(cmd, installCmd) {
  try { await exec(cmd); return true; }
  catch (_){
    if (installCmd){
      try { await exec(installCmd); return true; }
      catch (_e2){ return false; }
    }
    return false;
  }
}

function isHttp(u){ return /^https?:\/\//i.test(u); }

async function getImageSize(imgPath){
  try {
    const out = await exec('identify -format "%w %h" "' + imgPath + '"');
    const parts = String(out.stdout || "").trim().split(/\s+/);
    const w = parseInt(parts[0], 10);
    const h = parseInt(parts[1], 10);
    if (w && h) return { w: w, h: h };
  } catch(e){
    console.log("identify failed for " + imgPath + ": " + e.message);
  }
  return { w: 800, h: 600 };
}

async function downloadToTemp(url){
  ensureDir(TMP_DIR);
  const base = url.split("?")[0];
  const ext = path.extname(base || "") || ".jpg";
  const out = path.join(TMP_DIR, "img_" + stamp() + ext);
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  fs.writeFileSync(out, Buffer.from(res.data));
  return out;
}

async function ensureLocalImage(src){
  if (isHttp(src)) return await downloadToTemp(src);
  return src;
}

async function resizeImageToFit(srcPath, maxW, maxH){
  ensureDir(TMP_DIR);
  const ext = path.extname(srcPath) || ".png";
  const outPath = path.join(TMP_DIR, "fit_" + stamp() + ext);
  const cmd = 'convert "' + srcPath + '" -resize ' + maxW + 'x' + maxH + '\\> "' + outPath + '"';
  await exec(cmd);
  const size = await getImageSize(outPath);
  return { path: outPath, w: size.w, h: size.h };
}

function calcFontSize(text, maxWidth, maxHeight){
  const len = text.length;
  if (len <= 0) return DEFAULTS.FONT_MIN;
  let size = Math.floor(Math.sqrt(maxWidth * 28 / len));
  if (typeof maxHeight === "number" && maxHeight > 0){
    const lines = Math.ceil(len / 20);
    const maxByH = Math.floor(maxHeight / (lines * 1.2));
    if (maxByH > 0) size = Math.min(size, maxByH);
  }
  if (size < DEFAULTS.FONT_MIN) size = DEFAULTS.FONT_MIN;
  if (size > DEFAULTS.FONT_MAX) size = DEFAULTS.FONT_MAX;
  return size;
}

async function measureTextWidth(text, fontSize, fontPath){
  try {
    ensureDir(TMP_DIR);
    const tempImg = path.join(TMP_DIR, "text_measure_" + stamp() + ".png");
    const cmd = 'convert -background transparent -fill white -font "' + fontPath + '" -pointsize ' + fontSize + ' -gravity center label:"' + String(text).replace(/"/g, '\\"') + '" "' + tempImg + '"';
    await exec(cmd);
    const size = await getImageSize(tempImg);
    if (fs.existsSync(tempImg)) fs.unlinkSync(tempImg);
    return size.w;
  } catch(e){
    console.log("Text width measurement failed, fallback: " + e.message);
    return Math.round(String(text).length * fontSize * 0.6);
  }
}

function applyFadeEffects(node, fx, totalDuration){
  const safeIn = (fx && typeof fx.fadeIn === "number") ? fx.fadeIn : 0.6;
  const safeOut = (fx && typeof fx.fadeOut === "number") ? fx.fadeOut : 0.6;
  if (typeof node.addEffect === "function"){
    node.addEffect("fadeIn", safeIn, 0.2);
    const outDelay = Math.max(0.2, totalDuration - safeOut);
    node.addEffect("fadeOut", safeOut, outDelay);
  }
}

// =====================
// VOICEVOX
// =====================
async function synthVoicevoxWav(text, speakerId, outWav, baseUrl){
  const q = await axios.post(baseUrl + "/audio_query", null, { params: { text: text, speaker: speakerId }, timeout: 15000 });
  const s = await axios.post(baseUrl + "/synthesis", q.data, { params: { speaker: speakerId }, responseType: "arraybuffer", headers: { "Content-Type": "application/json" }, timeout: 60000 });
  fs.writeFileSync(outWav, Buffer.from(s.data));
  return outWav;
}

async function audioDurationSec(file){
  const out = await exec('ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "' + file + '"');
  const sec = parseFloat(String(out.stdout || "").trim());
  return isNaN(sec) ? 0 : sec;
}

// =====================
// Rendering (one scene)
// =====================
async function renderSilentScene(sceneCfg, fontPath, outMp4, durationSec, videoCfg){
  const W = videoCfg.width;
  const H = videoCfg.height;
  const margin = videoCfg.margin;

  return new Promise(async function(resolve, reject){
    try {
      const creator = new FFCreator({
        width: W,
        height: H,
        fps: videoCfg.fps,
        cacheDir: TMP_DIR,
        output: outMp4,
        debug: false,
        log: false,
      });

      const scene = new FFScene();
      scene.setBgColor(videoCfg.bgColor);
      scene.setDuration(Math.max(0.5, durationSec));

      const text = String(sceneCfg.text || "");
      const maxTextW = W - margin * 2;
      const textAreaH = 140;
      const fontSize = calcFontSize(text, maxTextW, textAreaH);
      const y = (typeof sceneCfg.textY === "number") ? sceneCfg.textY : Math.floor(H * 0.2);

      const textWidth = await measureTextWidth(text, fontSize, fontPath);
      const x = Math.floor((W - textWidth) / 2);

      const txt = new FFText({ text: text, x: x, y: y, fontSize: fontSize, color: sceneCfg.textColor || DEFAULTS.FONT_COLOR, font: fontPath });
      txt.setStyle({ textAlign: "center" });
      applyFadeEffects(txt, (sceneCfg.effects && sceneCfg.effects.text) ? sceneCfg.effects.text : null, durationSec);
      scene.addChild(txt);

      if (sceneCfg.image && sceneCfg.image.src){
        const local = await ensureLocalImage(sceneCfg.image.src);
        if (fs.existsSync(local)){
          const yImg = (typeof sceneCfg.image.y === "number") ? sceneCfg.image.y : Math.floor(H * 0.5);
          const maxW = Math.max(1, Math.min(sceneCfg.image.maxW || (W - margin * 2), W - margin * 2));
          const roomBelow = Math.max(1, H - margin - yImg);
          const maxH = Math.max(1, Math.min(sceneCfg.image.maxH || roomBelow, roomBelow));
          const fitted = await resizeImageToFit(local, maxW, maxH);
          const xImg = Math.floor((W - fitted.w) / 2);

          const img = new FFImage({ path: fitted.path, x: xImg, y: yImg, width: fitted.w, height: fitted.h });
          applyFadeEffects(img, (sceneCfg.effects && sceneCfg.effects.image) ? sceneCfg.effects.image : null, durationSec);
          scene.addChild(img);
        } else {
          console.log("Image not found: " + local);
        }
      }

      creator.addChild(scene);
      creator.on("complete", function(){ resolve(outMp4); });
      creator.on("error", function(e){ reject(new Error(errStr(e))); });
      creator.start();
    } catch(e){ reject(e); }
  });
}

async function mux(videoMp4, audioWav, outMp4){
  const cmd = 'ffmpeg -y -i "' + videoMp4 + '" -i "' + audioWav + '" -c:v copy -c:a aac -shortest "' + outMp4 + '"';
  await exec(cmd);
  return outMp4;
}

async function concatCopy(listFile, outPath){
  const cmd = 'ffmpeg -y -safe 0 -f concat -i "' + listFile + '" -c copy "' + outPath + '"';
  await exec(cmd);
  return outPath;
}

async function concatReencode(listFile, outPath){
  const cmd = 'ffmpeg -y -safe 0 -f concat -i "' + listFile + '" -c:v libx264 -preset veryfast -crf 23 -c:a aac "' + outPath + '"';
  await exec(cmd);
  return outPath;
}

// =====================
// Core pipeline (sync per-request)
// =====================
async function renderVideoFromConfig(cfg){
  // sanity check tools
  const okFF = await checkCmd("ffmpeg -version", "");
  const okFP = await checkCmd("ffprobe -version", "");
  const okID = await checkCmd("identify -version", "");
  const okCV = await checkCmd("convert -version", "");
  if (!okFF || !okFP) throw new Error("ffmpeg/ffprobe not available");
  if (!okID || !okCV) throw new Error("ImageMagick (identify/convert) not available");

  // font
  if (!fs.existsSync(cfg.font.path)) throw new Error("Font not found: " + cfg.font.path);

  // 1) voice per scene
  const sceneAudios = [];
  for (let i = 0; i < cfg.scenes.length; i++){
    const sc = cfg.scenes[i];
    const wav = path.join(TMP_DIR, "scene_" + (i+1) + "_" + stamp() + ".wav");
    await synthVoicevoxWav(sc.text || "", cfg.voicevox.speakerId, wav, cfg.voicevox.baseUrl);
    const dur = await audioDurationSec(wav);
    const finalDur = Math.max(sc.minDuration || 0, Math.ceil(dur + 0.5));
    sceneAudios.push({ wav: wav, dur: finalDur });
  }

  // 2) silent videos
  const silentMp4s = [];
  for (let i = 0; i < cfg.scenes.length; i++){
    const sc = cfg.scenes[i];
    const out = path.join(TMP_DIR, "scene_" + (i+1) + "_silent_" + stamp() + ".mp4");
    const mp4 = await renderSilentScene(sc, cfg.font.path, out, sceneAudios[i].dur, cfg.video);
    silentMp4s.push(mp4);
  }

  // 3) mux each scene
  const clips = [];
  for (let i = 0; i < cfg.scenes.length; i++){
    const out = path.join(TMP_DIR, "scene_" + (i+1) + "_mux_" + stamp() + ".mp4");
    await mux(silentMp4s[i], sceneAudios[i].wav, out);
    clips.push(out);
  }

  // 4) concat
  const listFile = path.join(TMP_DIR, "concat_" + stamp() + ".txt");
  const lines = clips.map(function(f){ return "file '" + path.resolve(f) + "'"; }).join("\n");
  fs.writeFileSync(listFile, lines, "utf8");

  const finalOut = path.join(OUT_DIR, "video_" + stamp() + ".mp4");
  try { await concatCopy(listFile, finalOut); }
  catch(e){ await concatReencode(listFile, finalOut); }

  return finalOut;
}

// =====================
// Request parsing
// =====================
function buildConfigFromBody(body){
  const voicevox = {
    baseUrl: String(body.voicevox_base || body.voicevoxBase || DEFAULTS.VOICEVOX_BASE),
    speakerId: Number(body.speaker_id || body.speakerId || DEFAULTS.VOICEVOX_SPEAKER_ID),
  };

  const video = {
    width: Number(body.video_w || body.width || DEFAULTS.VIDEO_W),
    height: Number(body.video_h || body.height || DEFAULTS.VIDEO_H),
    fps: Number(body.video_fps || body.fps || DEFAULTS.VIDEO_FPS),
    bgColor: String(body.bg_color || body.bgColor || DEFAULTS.VIDEO_BG),
    margin: Number(body.margin || DEFAULTS.VIDEO_MARGIN),
  };

  const font = {
    path: String(body.font_path || body.fontPath || DEFAULTS.FONT_PATH),
    family: String(body.font_family || body.fontFamily || "AppJP"),
    color: String(body.font_color || body.fontColor || DEFAULTS.FONT_COLOR),
    maxSize: Number(body.font_max || body.fontMax || DEFAULTS.FONT_MAX),
    minSize: Number(body.font_min || body.fontMin || DEFAULTS.FONT_MIN),
  };

  var scenes = [];
  if (body && Array.isArray(body.scenes) && body.scenes.length > 0){
    for (var i = 0; i < body.scenes.length; i++){
      var scIn = body.scenes[i] || {};
      var sc = {
        text: String(scIn.text || ""),
        textY: (typeof scIn.textY === "number") ? scIn.textY : 200,
        minDuration: Number(scIn.minDuration || 5),
        image: scIn.image && scIn.image.src ? {
          src: String(scIn.image.src || ""),
          y: (typeof scIn.image.y === "number") ? scIn.image.y : 450,
          maxW: Number(scIn.image.maxW || (video.width - video.margin * 2)),
          maxH: Number(scIn.image.maxH || 600),
        } : null,
        effects: scIn.effects || null,
      };
      scenes.push(sc);
    }
  } else {
    // Accept CF7-like flat fields: text_1, image_1, ..., text_n, image_n
    var maxN = Number(body.max_n || body.maxN || 50);
    if (!maxN || maxN < 1) maxN = 50;
    for (var j = 1; j <= maxN; j++){
      var t = body['text_' + j];
      var img = body['image_' + j];
      if (typeof t === "undefined" && typeof img === "undefined") continue;
      if ((t && String(t).trim() !== "") || (img && String(img).trim() !== "")){
        var sc2 = {
          text: String(t || ""),
          textY: Number(body['textY_' + j] || 200),
          minDuration: Number(body['minDuration_' + j] || body.minDuration || 5),
          image: img ? { src: String(img), y: Number(body['imageY_' + j] || 450), maxW: Number(body['imageMaxW_' + j] || (video.width - video.margin * 2)), maxH: Number(body['imageMaxH_' + j] || 600) } : null,
          effects: null,
        };
        scenes.push(sc2);
      }
    }
  }

  return { voicevox: voicevox, video: video, font: font, scenes: scenes };
}

// =====================
// Express app
// =====================
const app = express();
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/output", express.static(OUT_DIR));

function authMiddleware(req, res, next){
  if (!DEFAULTS.API_KEY) return next();
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key && key === DEFAULTS.API_KEY) return next();
  res.status(401).json({ ok:false, error: "unauthorized" });
}

app.get("/health", function(_req, res){ res.json({ ok:true, ffmpeg:true, voicevox: DEFAULTS.VOICEVOX_BASE }); });

app.post("/api/render", authMiddleware, async function(req, res){
  try {
    const body = req.body || {};
    const cfg = buildConfigFromBody(body);
    if (!cfg.scenes || cfg.scenes.length === 0){
      return res.status(400).json({ ok:false, error:"no scenes" });
    }

    const outPath = await renderVideoFromConfig(cfg);
    const fileName = path.basename(outPath);
    const urlPath = "/output/" + fileName;
    res.json({ ok:true, file: fileName, url: urlPath, absPath: outPath });
  } catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error: errStr(e) });
  }
});

const server = http.createServer(app);
server.listen(DEFAULTS.PORT, function(){
  console.log("Re:NEMA API listening on :" + DEFAULTS.PORT);
});
