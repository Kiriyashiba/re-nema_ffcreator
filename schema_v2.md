# Re:NEMA 台本JSON スキーマ v2

動画生成エンジンへの入力契約。将来 LLM に生成させる対象そのもの。

- **実装状況の記号**
  - ✅ = `re_nema_4_koma_server_v3.js` 実装済み
  - ⏳ = v2 では定義のみ。次段階で実装
- v1（`re_nema_4_koma_server.js`）との互換は維持する。v1 形式の JSON はそのまま受理される。

---

## 1. 全体構造

```jsonc
{
  "meta":   { "title": "", "description": "", "variant": "" },
  "video":  { "width": 720, "height": 1280, "fps": 25, "bgColorDefault": "#212121" },
  "voice":  { "ref": "mycoe" },
  "bgm":    { "file": "xxx.mp3", "volume": 0.15, "loop": true },
  "outro":  { "enabled": true, "cta": "…", "duration": 3.0 },
  "scenes": [ /* 下記 */ ]
}
```

| フィールド | 型 | 既定 | 状態 | 備考 |
|---|---|---|---|---|
| `meta.title` / `meta.description` | string | `""` | ✅ | 生成物には焼き込まれない。記録用 |
| `meta.variant` | string | `""` | ✅ | **A/Bテスト用のラベル**。出力の sidecar JSON に記録される |
| `video.width` / `height` / `fps` | number | 720 / 1280 / 25 | ✅ | |
| `video.bgColorDefault` | string | `"#212121"` | ✅ | 全体の背景色 |
| `voice.ref` | VoiceRef | `2` | ✅ | 既定話者。シーン側で上書き可 |
| `bgm.file` | string | — | ✅ | `sounds/bgm/` 内のファイル名 |
| `outro` | object | — | ✅ | CTA・クレジット用の末尾シーン |
| `credit` | object | `{mode:"corner"}` | ✅ | クレジット表記の出し方。下記 |
| `scenes` | array | `[]` | ✅ | 上限は `MAX_SCENES`（既定 20） |

**v1 との差分**: `voice.speakerId`（整数）は `voice.ref` に一般化された。整数を渡した場合は VOICEVOX の話者IDとして解釈されるため、既存の JSON はそのまま動く。

---

## 2. VoiceRef（話者の指定方法）

エンジンごとに話者の識別方法が異なるため、**参照は文字列/数値に正規化する**。

| 書き方 | 例 | 意味 |
|---|---|---|
| プリセット名 | `"mycoe"` | サーバー側の `VOICES` 表を引く。**LLM にはこれだけを使わせる** |
| 数値 | `2` | VOICEVOX の話者ID（v1互換） |
| `voicevox:<id>` | `"voicevox:3"` | VOICEVOX 明示 |
| `coeiroink:<uuid>:<styleId>` | `"coeiroink:6482c5b6-…:85727985"` | COEIROINK 明示 |

### なぜプリセットを挟むのか

COEIROINK は話者を `speakerUuid`（UUID文字列）+ `styleId`（整数）の**組**で識別する。VOICEVOX の「整数1個」とは互換性がない。この差を LLM に意識させると、

- UUID を幻覚する
- クレジット表記が台本ごとにブレる／漏れる

という事故が起きる。**LLM には名前だけ選ばせ、実体（エンジン・UUID・クレジット文）はサーバー側の表に持つ。**

### VOICES 表（サーバー側・環境変数 `VOICES_JSON` で差し替え可）

```jsonc
{
  "mycoe":    { "engine": "coeiroink", "speakerUuid": "6482c5b6-25b7-11f0-bf36-c641f37a1721",
                "styleId": 85727985, "label": "自分の声", "credit": "COEIROINK:MYCOEIROINK" },
  "tsukuyomi":{ "engine": "coeiroink", "speakerUuid": "3c37646f-3881-5374-2a83-149267990abc",
                "styleId": 0, "label": "つくよみちゃん", "credit": "COEIROINK:つくよみちゃん" },
  "default":  { "engine": "voicevox",  "speakerId": 2, "label": "VOICEVOX 既定" }
}
```

> **クレジットはライセンス義務**。COEIROINK の利用規約は「クレジットをすること（例:「COEIROINK:<合成音声名>」）」を明記している。
> `credit` を省略した場合、サーバーはエンジンの `/v1/speaker_policy` と話者名から自動生成する。
> ⏳ **動画への焼き込みは次段階**。それまで COEIROINK 系の声で作った動画を公開してはいけない。

---

## 3. Scene

```jsonc
{
  "durationMin": 0,
  "durationMax": 5,
  "content": { "type": "image", "url": "…", "fit": "contain", "srcAudioVolume": 0 },
  "topText":    { "text": "…", "speak": true,  "voice": "mycoe" },
  "bottomText": { "text": "…", "speak": false, "voice": "tsukuyomi" },
  "sfx": { "file": "pon.mp3", "volume": 1.0 },
  "transition": "fade"
}
```

| フィールド | 型 | 既定 | 状態 | 備考 |
|---|---|---|---|---|
| `durationMin` | number(秒) | `DEFAULT_MIN_DUR`（既定 **0**） | ✅ | **0 = パディングなし**。尺は音声の実長で決まる |
| `durationMax` | number(秒) | — | ✅(警告のみ) | 超過してもエンジンは切らない。**ログに警告を出すだけ**。台本側で守る値 |
| `content.type` | `"image"` \| `"video"` | 自動判定 | ✅ | |
| `content.url` | string | — | ✅ | http(s) またはローカルパス |
| `content.fit` | `"contain"` \| `"cover"` | `"contain"` | ✅ | |
| `content.srcAudioVolume` | number 0.0–1.0 | `0` | ⏳ | 元動画音声の音量。**0 = 無音**。v1 の `useSrcAudio` 真偽値を置換 |
| `topText.text` / `bottomText.text` | string | `""` | ✅ | |
| `*.speak` | boolean | `false` | ✅ | 読み上げるか |
| `*.voice` | VoiceRef | `voice.ref` | ✅ | **シーン・位置単位で話者を変えられる** |
| `sfx.file` | string | — | ✅ | `sounds/sfx/` 内のファイル名 |
| `transition` | enum | `"fade"` | ⏳ | 下記 |

### 尺の決まり方（v3 で修正済み）

```
音声実長 = 上テキスト音声 + 下テキスト音声（連結）+ SFX 重畳
target   = max(durationMin, 音声実長 + 0.12)
最終尺   = ceil(target × fps) / fps      ← フレーム境界に切り上げ
```

> **v1 のバグ**: 上記で小数まで計算した尺を、直後に `Math.floor()` で整数秒に切り捨てていたため、
> **音声の末尾が最大1秒弱切れていた**。`durationMin: 5` が短い音声をちょうど 5.000 秒に
> 揃えていたため表面化していなかったが、パディングを外すと全シーンで顕在化する。**v3 で修正済み。**

### 読み上げなしシーン

音声が1つも無い場合、尺は `durationMin` → それも 0 なら `SILENT_SCENE_DUR`（既定 3秒）。
**長さ0のシーンは作られない。**

---

## 4. transition（⏳ 次段階）

LLM に直接選ばせない。**`meta.tone` を選ばせ、サーバー側の対応表で遷移に変換する。**

| tone | 割り当てられる遷移 |
|---|---|
| `news` | `cut` / `fade`（短め） |
| `story` | `fade` / `dissolve` |
| `comedy` | `cut` / `slide` |

- シーン内で完結する効果（`fade` / `cut` / `zoom` / `slide`）は既存の1パスにフィルタを足すだけ。**パス数もメモリも増えない**
- 2シーンをまたぐ効果（`dissolve` = ffmpeg `xfade`）は連結段の構造変更が必要。
  **2本ずつ逐次合成**すればシーン数によらずメモリ一定に保てる（2GB制約への対応）
- 未知の値は黙って `fade` にフォールバックする

---

## 5. credit / outro（✅ 実装済み）

```jsonc
"credit": { "mode": "corner", "text": "" },
"outro":  { "enabled": true, "cta": "台本ください→プロフィールへ", "duration": 3.0, "bgColor": "#111111" }
```

### credit

| `mode` | 挙動 |
|---|---|
| `"corner"` **(既定)** | 全シーンの右下に小さく焼き込む |
| `"outro"` | 末尾カードにのみ表示 |
| `"both"` | 両方 |
| `"none"` | 入れない。**規約違反の恐れがあるため警告ログを出す** |

- `text` を省略すると、**その動画で実際に読み上げた話者から自動生成**される
  （例: `COEIROINK:寝間ショウヤ / VOICEVOX:四国めたん`）。手入力に頼らないので表記漏れが起きない
- クレジットは描画より先に確定させる必要があるため、レンダリング前に
  **事前パスで話者を解決**している。`sceneVoices()` を `buildSceneAudio` と共用し、
  事前パスと本番で同じ結論になることを保証している
- `corner` 指定時は下部テキストをクレジットの高さ分だけ持ち上げ、重なりを回避する
- 動画全体に後からオーバーレイしないのは、`addBgm` の `-c:v copy` が使えなくなり
  全編再エンコードになるため。**各シーンのキャンバス生成時に合成している**

### outro

- 末尾に専用シーンを1つ追加。`cta` が上部テキスト、クレジットが下部テキストになる
- 通常のレンダリング経路をそのまま通るので、新しい仕組みを増やしていない
- 読み上げが無いため、尺は `duration`（既定3.0秒）で決まる
- `bgColor` で本編と背景色を変えられる（省略時は `video.bgColorDefault`）

---

## 6. LLM に台本を生成させる際の制約

サーバー側で強制できない（＝プロンプトで守らせる）ものを明示する。

| 制約 | 値 | 根拠 |
|---|---|---|
| 1シーンの文字数 | **40文字以内**（上下テキスト合計） | 実測 **36文字 = 4.089秒**（speedScale 1.0）＝ 約 8.8文字/秒。5秒 ≈ 44文字 |
| シーン数（ストーリー系） | 4 | 4コマという形式上の制約 |
| シーン数（ニュース系） | 台本次第、上限 `MAX_SCENES`(20) | シーンを増やすと固定オーバーヘッド（TTS往復＋ImageMagick＋ffmpeg 2パス）が比例増。**生成速度はトレンド用途の実質的制約** |
| `voice.ref` | `VOICES` のキーのみ | UUID を直接書かせない |
| `transition` | 指定させない | `meta.tone` のみ選ばせる |

> 文字数上限をエンジン側で強制しないのは、超過時にできることが「音声を途中で切る」か
> 「speedScale で早口にする」しかないため。前者は語尾が飛び、後者は声質が変わる。
> **自分の声を使う以上どちらも避けたい。** よって上限は台本生成時のバリデーション事項とする。

---

## 7. 出力

```
output/video_YYYYMMDD_HHMMSS.mp4        ← 動画
output/video_YYYYMMDD_HHMMSS.mp4.json   ← sidecar（v3 で追加）
```

sidecar には **レンダリングに使った cfg 全体・使用話者・クレジット文字列・所要時間** が入る。

これが無いと「どの動画がどの条件で作られたか」を後から復元できず、**A/Bテストが原理的に成立しない**
（v1 は cfg をレンダリング後に破棄し、タイムスタンプ名の mp4 しか残らなかった）。
ジョブ情報がメモリ上にしか無くプロセス再起動で消える問題も、これで実質的に緩和される。
