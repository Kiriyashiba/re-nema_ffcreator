const { FFCreator, FFScene, FFText } = require('ffcreatorlite');

async function run() {
  const creator = new FFCreator({
    width: 640,
    height: 360,
    debug: true,
    output: './output.mp4',
    cacheDir: './cache',
  });

  const scene = new FFScene();
  scene.setBgColor('#000000');
  scene.setDuration(3);

  const text = new FFText({
    text: 'Hello FFCreatorLite!',
    x: 100,
    y: 150,
    fontSize: 36,
    color: '#ffffff',
  });

  scene.addChild(text);
  creator.addChild(scene);

  // 開始して完了を待つ
  await creator.start();

  console.log('🎬 動画出力が完了しました！');
}

run().catch(err => {
  console.error('❌ エラーが発生しました:', err);
});

