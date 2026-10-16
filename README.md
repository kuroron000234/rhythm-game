# AUTO BEAT

好きな曲の音声ファイルをドロップすると、その場で AI が譜面を作って遊べる 4 レーン音ゲーです。

**ブラウザ版: https://kuroron000234.github.io/rhythm-game/** (インストール不要。曲名で検索するか、音声ファイルを入れるだけ)

曲名・アーティスト名で検索すると、[Audius](https://audius.co) で公開されている曲をその場で再生して譜面にします。Audius の [API 規約](https://audius.co/legal/api-terms) に従い、Audius の曲の音声と譜面はそのページを開いている間だけメモリーに置き、ブラウザにもサーバーにも保存しません(履歴には曲 ID と曲名だけを残し、次に遊ぶときに取得し直します)。曲ページへのリンクとアーティスト名を表示します。Audius の曲は譜面モデルの学習には使いません。

自分の PC でサーバーを立てると、YouTube などの URL からの読み込みや、より大きな AI モデルでの譜面生成も使えます。

- YouTube などの URL から音声を取得(yt-dlp)。ローカルの音声ファイルにも対応
- EASY / NORMAL / HARD の 3 難易度、ロングノーツ、クリティカルノーツ、同時押し
- 奥行きのあるレーン(プロセカ風)、判定(PERFECT / GREAT / GOOD / MISS)、ライフ、スコア、ランク
- 曲ごとのハイスコア、判定オフセットの自動調整、ハイスピ、キー配置、効果音の差し替え

## 譜面の作られ方

使える方法の中で一番良いものを自動で選びます。サーバーを使う AI 譜面は裏で作られ、できたら差し替わります(次に開いたときは最初から AI 譜面)。

| 方法 | 内容 | 必要なもの |
|---|---|---|
| **ブラウザ内 AI 譜面** | MuG Diffusion の譜面を手本に学習した小さなモデル(約 4MB)がブラウザの中で譜面を作る。タイミングを決める部分と、直前の配置を見ながらレーンを 1 つずつ決める部分の 2 段構え | なし(GitHub Pages 版もこれ) |
| **MuG 譜面**(おすすめ) | [MuG Diffusion](https://github.com/Keytoyze/Mug-Diffusion) が、人の作った 4 キー譜面から学習したパターンで譜面を作る | `npm run setup-mug`。GPU 推奨(RTX 4060 で 1 曲約 20 秒)。CPU でも動くが遅い |
| **ボーカル連動譜面** | [Demucs](https://github.com/facebookresearch/demucs) でボーカルを分離し、歌の音符にノーツ、伸ばす声にロングを置く | `npm run setup-ai`。GPU 推奨(約 20 秒)、CPU だと数分 |
| **通常譜面** | 音の立ち上がり・テンポ・曲の盛り上がりから規則で配置(モデルが読めない時の予備) | なし |

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

## ブラウザ内モデルの学習(`ml/`)

```bash
python3 ml/collect.py --per-genre 150      # 学習用の曲を集める(手元のみ。公開しない)
python3 ml/teacher.py --seeds 2            # MuG で手本の譜面を作る(要 setup-mug、GPU 推奨)
python3 ml/dataset.py                      # 特徴量と手本を学習用データに変換
python3 ml/train.py --out runs/x           # 学習(ml/rig.sh で別マシンの GPU にも投げられる)
ml/.venv/bin/python ml/export.py runs/x/best.pt public/model   # ブラウザ用に書き出し
python3 ml/evaluate.py runs/x/best.pt --meta public/model/chartnet.json   # テスト曲で評価
```

学習データは手元で集めた 260 曲(ボカロ / J-POP・アニソン)と、MuG が各曲に作った手本 2 通り。テスト用 32 曲での MuG 譜面とのノーツ位置一致率(±50ms):

| | EASY | NORMAL | HARD |
|---|---|---|---|
| MuG 同士(乱数違い、上限の目安) | 0.91 | 0.90 | 0.89 |
| **ブラウザ内モデル** | **0.76** | **0.79** | **0.79** |
| 規則ベースの通常譜面 | 0.57 | 0.67 | 0.67 |

特徴量の計算(`ml/features.py` ⇔ `src/analysis/mel.ts`)と譜面への変換(`ml/train.py` decode ⇔ `src/analysis/neural.ts`)は、Python とブラウザで同じ結果になることをテストで確認しています。

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
- 解析結果・ハイスコア・設定はブラウザの IndexedDB に保存されます(Audius の曲の解析結果は保存しません)
- サーバーは `127.0.0.1` だけで待ち受けます

## 注意とライセンス

- 個人で遊ぶためのアプリです。サーバーを公開して他人に使わせることは想定していません。動画サイトの音声の扱いは各サービスの規約に従ってください
- yt-dlp が動かなくなったら `yt-dlp -U` で更新すると直ることがあります。年齢制限やログインが必要な動画は取得できません
- ブラウザ内モデル(`public/model/`)は MuG Diffusion の譜面を手本に学習したものなので、MuG と同じく**非商用でのみ利用可**です
- MuG Diffusion: コードは MIT ライセンス。**モデルと生成された譜面は非商用でのみ利用可**。公式の配布物は Google Drive 上のアプリ ZIP のみのため、`setup-mug` は Hugging Face 上の再アップロード版を SHA-256 で検査してから使い、数値データ以外を受け付けない方法(`weights_only`)で読み込みます
- Demucs: MIT ライセンス
