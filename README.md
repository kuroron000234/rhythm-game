# AUTO BEAT

好きな曲の URL を貼る(または音声ファイルをドロップする)と、その場で譜面を作って遊べる 4 レーン音ゲーです。
自分の PC でサーバーを立ててブラウザで遊ぶ、個人用のローカルアプリです。

- YouTube などの URL から音声を取得(yt-dlp)。ローカルの音声ファイルにも対応
- EASY / NORMAL / HARD の 3 難易度、ロングノーツ、クリティカルノーツ、同時押し
- 奥行きのあるレーン(プロセカ風)、判定(PERFECT / GREAT / GOOD / MISS)、ライフ、スコア、ランク
- 曲ごとのハイスコア、判定オフセットの自動調整、ハイスピ、キー配置、効果音の差し替え

## 譜面の作られ方

使える方法の中で一番良いものを自動で選びます。どの方法でも、まず通常譜面で数秒後には遊べます。AI 譜面は裏で作られ、できたら差し替わります(次に開いたときは最初から AI 譜面)。

| 方法 | 内容 | 必要なもの |
|---|---|---|
| **MuG 譜面**(おすすめ) | [MuG Diffusion](https://github.com/Keytoyze/Mug-Diffusion) が、人の作った 4 キー譜面から学習したパターンで譜面を作る | `npm run setup-mug`。GPU 推奨(RTX 4060 で 1 曲約 20 秒)。CPU でも動くが遅い |
| **ボーカル連動譜面** | [Demucs](https://github.com/facebookresearch/demucs) でボーカルを分離し、歌の音符にノーツ、伸ばす声にロングを置く | `npm run setup-ai`。GPU 推奨(約 20 秒)、CPU だと数分 |
| **通常譜面** | ブラウザ内で音の立ち上がり・テンポ・曲の盛り上がりを解析して配置 | なし |

## 必要なもの

- Node.js 22 以上
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)(URL から読み込む場合)と ffmpeg
- AI 譜面を使う場合: Python 3 と git(PyTorch が入っていればそれを使い、なければ CPU 版を入れます)

## はじめかた

```bash
npm install
npm start            # ビルドしてサーバー起動 → http://127.0.0.1:5173
```

AI 譜面を使う場合(どちらか、または両方):

```bash
npm run setup-mug    # MuG Diffusion(.mug/ に約 2GB)
npm run setup-ai     # Demucs(.venv-ai/)
```

起動時のログとタイトル画面に、どの AI 譜面が有効かが表示されます。

## 遊び方

| 操作 | キー |
|---|---|
| レーン | `D` `F` `J` `K`(設定で変更可) |
| 難易度選択 | `←` `→`、`Enter` で開始 |
| 一時停止 | `Esc`(再開 `Esc` / リトライ `R` / 曲選択へ `Q`) |
| リザルト | リトライ `R` / 難易度選択 `Enter` / タイトル `Esc` |

音と判定がずれると感じたら、設定の「オフセット自動調整」でクリック音に合わせて Space を叩くと、判定オフセットが自動で設定されます。

効果音はプロセカの傾向に寄せた合成音です。設定画面から手元の音声ファイルに差し替えられます(ゲームの音源は同梱していません)。

## 開発

```bash
npm run dev          # Vite の開発サーバー + API サーバー(自動リロード)
npm test             # Vitest
npm run build        # 型チェック + ビルド
```

```
server/          Express。yt-dlp 取得・キャッシュ・AI ジョブ(Demucs / MuG)の API
  ytdlp.ts       yt-dlp の呼び出し
  jobs.ts        GPU 処理を 1 件ずつ流すジョブキュー
  separator.ts   Demucs によるボーカル分離
  mug.ts         MuG Diffusion の呼び出し
src/
  analysis/      Web Worker で動く解析(STFT・オンセット・テンポ・区間の盛り上がり・ボーカル音符・譜面生成)
                 osu.ts は MuG が出力した osu!mania 譜面を曲の拍グリッドに合わせて変換
  game/          AudioContext 基準の時計・判定・Canvas 描画・効果音
  ui/            タイトル / 難易度選択 / プレイ / リザルト / 設定
scripts/         AI のセットアップスクリプトと MuG のコマンドライン実行用スクリプト
docs/superpowers 設計仕様と実装計画
```

- 取得した音声・分離したパート・MuG の譜面は `~/.cache/rhythm-game/` にキャッシュされます(`RG_CACHE` で変更可)
- 解析結果・ハイスコア・設定はブラウザの IndexedDB に保存されます
- サーバーは `127.0.0.1` だけで待ち受けます

## 注意とライセンス

- 個人で遊ぶためのアプリです。サーバーを公開して他人に使わせることは想定していません。動画サイトの音声の扱いは各サービスの規約に従ってください
- yt-dlp が動かなくなったら `yt-dlp -U` で更新すると直ることがあります。年齢制限やログインが必要な動画は取得できません
- MuG Diffusion: コードは MIT ライセンス。**モデルと生成された譜面は非商用でのみ利用可**。公式の配布物は Google Drive 上のアプリ ZIP のみのため、`setup-mug` は Hugging Face 上の再アップロード版を SHA-256 で検査してから使い、数値データ以外を受け付けない方法(`weights_only`)で読み込みます
- Demucs: MIT ライセンス
