"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const util = require("util");
const child = require("child_process");
const exec = util.promisify(child.exec);
const { FFCreator, FFScene, FFText, FFImage } = require("ffcreatorlite");

/* ========= EDIT HERE (simple JSON-like config) ========= */
const CONFIG = {
  voicevox: {
    baseUrl: process.env.VOICEVOX_BASE || "http://127.0.0.1:50021",
    speakerId: Number(process.env.VOICEVOX_SPEAKER_ID || 2)
  },
  video: {
    width: 720,
    height: 1280,
    fps: 25,
    bgColor: "#303030",
    margin: 20
  },
  font: {
    // Fixed to Noto Sans JP (ttf)
    path: "fonts/NotoSansJP-Regular.ttf",
    family: "AppJP",
    color: "#ffffff",
    maxSize: 56,
    minSize: 18
  },
  scenes: [
    {
      comment: "Scene 1",
      text: "ある日、変な桃から桃太郎が生まれました",
      textY: 200,
      minDuration: 5,
      image: { src: "./images/test1.jpg", y: 450, maxW: 680, maxH: 600 },
      effects: { text: { fadeIn: 0.6, fadeOut: 0.6 }, image: { fadeIn: 0.8, fadeOut: 0.8 } }
    },
    {
      comment: "Scene 2",
      text: "なんかしらんけど仲間見つけて鬼をたおしました",
      textY: 200,
      minDuration: 5,
      image: { src: "./images/test2.jpg", y: 450, maxW: 680, maxH: 600 },
      effects: { text: { fadeIn: 0.6, fadeOut: 0.6 }, image: { fadeIn: 0.8, fadeOut: 0.8 } }
    },
    {
      comment: "Scene 3",
      text: "村に帰ると謎にUFOがすべてをかっさらっていきそうでした。続く！",
      textY: 200,
      minDuration: 5,
      image: { src: "./images/test3.jpg", y: 450, maxW: 680, maxH: 600 },
      effects: { text: { fadeIn: 0.6, fadeOut: 0.6 }, image: { fadeIn: 0.8, fadeOut: 0.8 } }
    }
  ]
};
/* ========= END EDIT ========= */

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, "output");
const TMP_DIR = path.join(ROOT, "temp");

function stamp() {
  const d = new Date();
  const z = n => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    z(d.getMonth() + 1) +
    z(d.getDate()) +
    "_" +
    z(d.getHours()) +
    z(d.getMinutes()) +
    z(d.getSeconds())
  );
}

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function errStr(err) {
  try {
    if (err && err.response && err.response.data) {
      if (typeof err.response.data === "string") return err.response.data;
      try { return JSON.stringify(err.response.data); } catch (_) { return String(err.response.data); }
    }
    if (err && err.message) return err.message;
    return String(err);
  } catch (e) { return "Unknown error"; }
}

async function checkCmd(cmd, installCmd) {
  try { await exec(cmd); return true; }
  catch (_) {
    if (installCmd) {
      try { await exec(installCmd); return true; }
      catch (e2) { return false; }
    }
    return false;
  }
}

/* ===== Image helpers (ImageMagick) ===== */
async function getImageSize(imgPath) {
  try {
    const out = await exec('identify -format "%w %h" "' + imgPath + '"');
    const parts = String(out.stdout || "").trim().split(/\s+/);
    const w = parseInt(parts[0], 10);
    const h = parseInt(parts[1], 10);
    if (w && h) return { w: w, h: h };
  } catch (e) {
    console.log("identify failed for " + imgPath + ": " + e.message);
  }
  return { w: 800, h: 600 };
}

function isHttp(u) { return /^https?:\/\//i.test(u); }

async function downloadToTemp(url) {
  ensureDir(TMP_DIR);
  const base = url.split("?")[0];
  const ext = path.extname(base || "") || ".jpg";
  const out = path.join(TMP_DIR, "img_" + stamp() + ext);
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  fs.writeFileSync(out, Buffer.from(res.data));
  return out;
}

async function ensureLocalImage(src) {
  if (isHttp(src)) return await downloadToTemp(src);
  return src;
}

/**
 * Physically resize into max box, keeping aspect ratio, never upscale.
 */
async function resizeImageToFit(srcPath, maxW, maxH) {
  ensureDir(TMP_DIR);
  const ext = path.extname(srcPath) || ".png";
  const outPath = path.join(TMP_DIR, "fit_" + stamp() + ext);
  const cmd = 'convert "' + srcPath + '" -resize ' + maxW + "x" + maxH + '\\> "' + outPath + '"';
  await exec(cmd);
  const size = await getImageSize(outPath);
  return { path: outPath, w: size.w, h: size.h };
}

/* ===== Text sizing ===== */
function calcFontSize(text, maxWidth, maxHeight) {
  const len = text.length;
  if (len <= 0) return CONFIG.font.minSize;
  // density-based rough estimate
  let size = Math.floor(Math.sqrt(maxWidth * 28 / len));
  if (typeof maxHeight === "number" && maxHeight > 0) {
    const lines = Math.ceil(len / 20);
    const maxByH = Math.floor(maxHeight / (lines * 1.2));
    if (maxByH > 0) size = Math.min(size, maxByH);
  }
  if (size < CONFIG.font.minSize) size = CONFIG.font.minSize;
  if (size > CONFIG.font.maxSize) size = CONFIG.font.maxSize;
  return size;
}

/**
 * ImageMagickを使って実際のテキスト幅を測定
 */
async function measureTextWidth(text, fontSize, fontPath) {
  try {
    ensureDir(TMP_DIR);
    const tempImg = path.join(TMP_DIR, "text_measure_" + stamp() + ".png");
    
    // ImageMagickでテキストを一時的に描画して幅を測定
    const cmd = `convert -background transparent -fill white -font "${fontPath}" -pointsize ${fontSize} -gravity center label:"${text.replace(/"/g, '\\"')}" "${tempImg}"`;
    await exec(cmd);
    
    // 生成された画像のサイズを取得
    const size = await getImageSize(tempImg);
    
    // 一時ファイルを削除
    if (fs.existsSync(tempImg)) {
      fs.unlinkSync(tempImg);
    }
    
    return size.w;
  } catch (e) {
    console.log("Text width measurement failed, using fallback: " + e.message);
    // フォールバック: 文字数による推定
    return Math.round(text.length * fontSize * 0.6);
  }
}

function applyFadeEffects(node, fx, totalDuration) {
  const safeIn = (fx && typeof fx.fadeIn === "number") ? fx.fadeIn : 0.6;
  const safeOut = (fx && typeof fx.fadeOut === "number") ? fx.fadeOut : 0.6;
  if (typeof node.addEffect === "function") {
    node.addEffect("fadeIn", safeIn, 0.2);
    const outDelay = Math.max(0.2, totalDuration - safeOut);
    node.addEffect("fadeOut", safeOut, outDelay);
  }
}

/* ===== VOICEVOX ===== */
async function synthVoicevoxWav(text, speakerId, outWav) {
  console.log('VOICEVOX synth: "' + text + '"');
  const q = await axios.post(
    CONFIG.voicevox.baseUrl + "/audio_query",
    null,
    { params: { text: text, speaker: speakerId }, timeout: 15000 }
  );
  const s = await axios.post(
    CONFIG.voicevox.baseUrl + "/synthesis",
    q.data,
    {
      params: { speaker: speakerId },
      responseType: "arraybuffer",
      headers: { "Content-Type": "application/json" },
      timeout: 60000
    }
  );
  fs.writeFileSync(outWav, Buffer.from(s.data));
  return outWav;
}

async function audioDurationSec(file) {
  const out = await exec('ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "' + file + '"');
  const sec = parseFloat(String(out.stdout || "").trim());
  return isNaN(sec) ? 0 : sec;
}

/* ===== Render one silent scene ===== */
async function renderSilentScene(sceneCfg, fontPath, outMp4, durationSec) {
  const W = CONFIG.video.width;
  const H = CONFIG.video.height;
  const margin = CONFIG.video.margin;

  return new Promise(async (resolve, reject) => {
    try {
      const creator = new FFCreator({
        width: W,
        height: H,
        fps: CONFIG.video.fps,
        cacheDir: TMP_DIR,
        output: outMp4,
        debug: false,
        log: false
      });

      const scene = new FFScene();
      scene.setBgColor(CONFIG.video.bgColor);
      scene.setDuration(Math.max(0.5, durationSec));

      // Text - 修正部分（実際の幅測定を使用）
      const text = String(sceneCfg.text || "");
      const maxTextW = W - margin * 2;
      const textAreaH = 140;
      const fontSize = calcFontSize(text, maxTextW, textAreaH);
      const y = typeof sceneCfg.textY === "number" ? sceneCfg.textY : Math.floor(H * 0.2);

      // テキストの実際の幅を測定してX座標を計算
      const textWidth = await measureTextWidth(text, fontSize, fontPath);
      const x = Math.floor((W - textWidth) / 2);

      const txt = new FFText({
        text: text,
        x: x,  // 測定した幅から計算した中央X座標
        y: y,
        fontSize: fontSize,
        color: CONFIG.font.color,
        font: fontPath
      });
      
      // テキストアライメントを中央に設定（複数行対応）
      txt.setStyle({
        textAlign: 'center'
      });
      
      applyFadeEffects(txt, (sceneCfg.effects && sceneCfg.effects.text) ? sceneCfg.effects.text : null, durationSec);
      scene.addChild(txt);

      // Image (pre-fit with ImageMagick, center X)
      if (sceneCfg.image && sceneCfg.image.src) {
        const local = await ensureLocalImage(sceneCfg.image.src);
        if (fs.existsSync(local)) {
          const yImg = typeof sceneCfg.image.y === "number" ? sceneCfg.image.y : Math.floor(H * 0.5);
          const maxW = Math.max(1, Math.min(sceneCfg.image.maxW || (W - margin * 2), W - margin * 2));
          const roomBelow = Math.max(1, H - margin - yImg);
          const maxH = Math.max(1, Math.min(sceneCfg.image.maxH || roomBelow, roomBelow));
          const fitted = await resizeImageToFit(local, maxW, maxH);
          const xImg = Math.floor((W - fitted.w) / 2);

          const img = new FFImage({
            path: fitted.path,
            x: xImg,
            y: yImg,
            width: fitted.w,
            height: fitted.h
          });
          applyFadeEffects(img, (sceneCfg.effects && sceneCfg.effects.image) ? sceneCfg.effects.image : null, durationSec);
          scene.addChild(img);
        } else {
          console.log("Image not found: " + local);
        }
      }

      creator.addChild(scene);

      creator.on("complete", function() {
        resolve(outMp4);
      });
      creator.on("error", function(e) {
        reject(new Error(errStr(e)));
      });

      creator.start();
    } catch (e) {
      reject(e);
    }
  });
}

/* ===== Mux and concat ===== */
async function mux(videoMp4, audioWav, outMp4) {
  const cmd = 'ffmpeg -y -i "' + videoMp4 + '" -i "' + audioWav + '" -c:v copy -c:a aac -shortest "' + outMp4 + '"';
  await exec(cmd);
  return outMp4;
}

async function concatCopy(listFile, outPath) {
  const cmd = 'ffmpeg -y -safe 0 -f concat -i "' + listFile + '" -c copy "' + outPath + '"';
  await exec(cmd);
  return outPath;
}

async function concatReencode(listFile, outPath) {
  const cmd = 'ffmpeg -y -safe 0 -f concat -i "' + listFile + '" -c:v libx264 -preset veryfast -crf 23 -c:a aac "' + outPath + '"';
  await exec(cmd);
  return outPath;
}

/* ===== Main ===== */
(async () => {
  try {
    console.log("Starting...");
    ensureDir(OUT_DIR);
    ensureDir(TMP_DIR);

    // Tools
    const okFF = await checkCmd("ffmpeg -version", "sudo apt update && sudo apt install -y ffmpeg");
    const okFP = await checkCmd("ffprobe -version", "sudo apt update && sudo apt install -y ffmpeg");
    const okID = await checkCmd("identify -version", "sudo apt update && sudo apt install -y imagemagick");
    const okCV = await checkCmd("convert -version", "sudo apt update && sudo apt install -y imagemagick");
    if (!okFF || !okFP) throw new Error("ffmpeg/ffprobe not available");
    if (!okID || !okCV) throw new Error("ImageMagick (identify/convert) not available");

    // Font exists
    if (!fs.existsSync(CONFIG.font.path)) {
      throw new Error("Font not found: " + CONFIG.font.path);
    }
    console.log("Using font: " + CONFIG.font.path);

    // Phase 1: voice per scene
    const sceneAudios = [];
    for (let i = 0; i < CONFIG.scenes.length; i++) {
      const sc = CONFIG.scenes[i];
      const wav = path.join(TMP_DIR, "scene_" + (i + 1) + "_" + stamp() + ".wav");
      await synthVoicevoxWav(sc.text, CONFIG.voicevox.speakerId, wav);
      const dur = await audioDurationSec(wav);
      const finalDur = Math.max(sc.minDuration || 0, Math.ceil(dur + 0.5));
      sceneAudios.push({ wav: wav, dur: finalDur });
      console.log("Scene " + (i + 1) + ": audio " + dur.toFixed(2) + "s -> video " + finalDur + "s");
    }

    // Phase 2: render silent videos
    const silentMp4s = [];
    for (let i = 0; i < CONFIG.scenes.length; i++) {
      const sc = CONFIG.scenes[i];
      const out = path.join(TMP_DIR, "scene_" + (i + 1) + "_silent_" + stamp() + ".mp4");
      const mp4 = await renderSilentScene(sc, CONFIG.font.path, out, sceneAudios[i].dur);
      silentMp4s.push(mp4);
    }

    // Phase 3: mux per scene
    const clips = [];
    for (let i = 0; i < CONFIG.scenes.length; i++) {
      const out = path.join(TMP_DIR, "scene_" + (i + 1) + "_mux_" + stamp() + ".mp4");
      await mux(silentMp4s[i], sceneAudios[i].wav, out);
      clips.push(out);
    }

    // Phase 4: concat
    const listFile = path.join(TMP_DIR, "concat_" + stamp() + ".txt");
    const lines = clips.map(f => "file '" + path.resolve(f) + "'").join("\n");
    fs.writeFileSync(listFile, lines, "utf8");

    const finalOut = path.join(OUT_DIR, "video_" + stamp() + ".mp4");
    try {
      await concatCopy(listFile, finalOut);
    } catch (e) {
      console.log("Fast concat failed, fallback to re-encode: " + errStr(e));
      await concatReencode(listFile, finalOut);
    }

    console.log("Done: " + finalOut);

  } catch (e) {
    console.error("Process failed: " + errStr(e));
    process.exit(1);
  }
})();