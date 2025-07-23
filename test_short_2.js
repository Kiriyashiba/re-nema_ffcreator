const { FFCreator, FFScene, FFText } = require('ffcreatorlite');
const { createCanvas } = require('canvas');

function getCenteredX(text, fontSize, canvasWidth, font = 'Noto Sans CJK JP') {
  const canvas = createCanvas(1, 1);
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px "${font}"`;
  const textWidth = ctx.measureText(text).width;
  return (canvasWidth - textWidth) / 2;
}

async function run() {
  const width = 720;
  const height = 1280;
  const fontSize = 32;
  const text = '驚きの結果はこちら！';

  const creator = new FFCreator({
    width,
    height,
    debug: true,
    output: './short_output.mp4',
    cacheDir: './cache',
  });

  const scene = new FFScene();
  scene.setBgColor('#545454');
  scene.setDuration(5);

  const x = getCenteredX(text, fontSize, width); // 自動中央計算

  const title = new FFText({
    text,
    x,
    y: 200,
    fontSize,
    color: '#ffffff',
    font: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  });

  title.addEffect('fadeInDown', 1.0, 0.5);
  title.addEffect('fadeOutUp', 1.0, 3.5);

  scene.addChild(title);
  creator.addChild(scene);

  await creator.start();
  console.log('🎬 動画出力完了: short_output.mp4');
}

run().catch(err => {
  console.error('❌ エラーが発生しました:', err);
});

