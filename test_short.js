const { FFCreator, FFScene, FFText } = require('ffcreatorlite');

async function run() {
  const creator = new FFCreator({
    width: 720,
    height: 1280,
    debug: true,
    output: './short_output.mp4',
    cacheDir: './cache',
  });

  const scene = new FFScene();
  scene.setBgColor('#545454');
  scene.setDuration(10);

  const title = new FFText({
    text: 'あいうえお',
    x: 0,
    y: 150,
    fontSize: 60,
    color: '#ffffff',
    align: 'center',
    font: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', // パスは環境に合わせて調整
  });

  // アニメーション効果（登場と退出）
  title.addEffect('fadeIn', 2, 1);  // 0秒後に1秒かけてフェードイン
  title.addEffect('fadeOut', 1, 6); // 4秒後に1秒かけてフェードアウト

  scene.addChild(title);
  creator.addChild(scene);

  await creator.start();
  console.log('🎬 ショート動画生成完了！');
}

run().catch(err => {
  console.error('❌ エラーが発生しました:', err);
});

