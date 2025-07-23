const fs = require('fs');
const { FFCreator, FFScene } = require('ffcreatorlite');

if (!fs.existsSync('cache')) fs.mkdirSync('cache');
if (!fs.existsSync('output')) fs.mkdirSync('output');

const creator = new FFCreator({
  cacheDir: 'cache',
  outputDir: 'output',
  width: 640,
  height: 360,
  log: true
});

const scene = new FFScene();  // ここが undefined なら読み込み失敗
scene.setBgColor('#000');
scene.setDuration(5);
creator.addChild(scene);

creator.start();
creator.on('progress', e => console.log(`進捗: ${(e.percent * 100).toFixed(1)}%`));
creator.on('complete', e => console.log(`完了：${e.output}`));

