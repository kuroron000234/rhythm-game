# 自動譜面生成リズムゲーム Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** URL(yt-dlp)またはローカル音声から譜面を自動生成して遊べる、プロセカ/Sparebeat 風 4 レーン音ゲーをローカル Web アプリとして作る。

**Architecture:** Node(Express) のローカルサーバーが yt-dlp で音声を取得・キャッシュし、ブラウザ(Vite + TS)が Web Worker 上の純関数 DSP パイプラインで解析・譜面生成、Canvas2D 透視描画でプレイする。時刻はすべて AudioContext の出力タイムスタンプ基準。

**Tech Stack:** TypeScript, Vite, Vitest, Express, tsx, yt-dlp(外部コマンド), IndexedDB, Canvas2D, Web Audio API

**Spec:** `docs/superpowers/specs/2026-10-13-rhythm-game-design.md`

## Global Constraints

- Node 22 / ESM。ランタイム依存は express のみ(フロントは依存ゼロ)
- 解析サンプルレート 22050Hz、STFT 窓 2048 / ホップ 512、帯域 <150 / 150–2000 / >2000 Hz
- 判定幅 PERFECT ±40ms / GREAT ±80ms / GOOD ±120ms、得点率 100/70/40/0%
- スコア 1,000,000 点満点、クリティカル重み 2、ランク S≥950k A≥900k B≥800k C<800k
- ライフ 初期100、MISS −8 / GOOD 0 / GREAT +0.5 / PERFECT +1
- 難易度 EASY(4分, ~3/s, 同時押しなし) NORMAL(8分, ~6/s, 強拍のみ2個) HARD(16分, ~10/s)
- 8 分より細かい同レーン連打禁止、ロング保持中は同じ手側に新規ノーツなし
- 20 分超の動画は拒否、サーバーは 127.0.0.1 のみで listen
- 既定キー D F J K

## Review Focus

- yt-dlp に `-` で始まる URL 等を渡されたときのオプション注入 → 必ず `--` の後に URL を置く(server テストで検証)
- 同じ URL を連打したときの二重ダウンロード → in-flight を共有(server テストで検証)
- 無音・極端に短い曲(<5秒)を解析したとき → 例外にならず空/少数ノーツの譜面を返す(analysis テストで検証)
- フリーテンポ/BPM 不安定な曲 → gridReliable=false で onset ベース配置(analysis テストで検証)
- 一時停止→再開・リトライでの時刻ずれ → clock は AudioContext suspend/resume に一本化(手動確認)

---

### Task 1: プロジェクト雛形

**Files:** Create `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore`

- [ ] npm init、依存: `express`; dev: `typescript vite vitest tsx @types/express @types/node`
- [ ] scripts: `dev`(vite + tsx watch server, API proxy /api→127.0.0.1:5174)、`build`、`start`(build 後 server が dist 配信 5173)、`test`(vitest run)
- [ ] Commit

### Task 2: サーバー(yt-dlp 取得 + キャッシュ)

**Files:** Create `server/ytdlp.ts`, `server/cache.ts`, `server/app.ts`, `server/index.ts`; Test `test/server.test.ts`

**Interfaces (Produces):**
```ts
interface SongMeta { id: string; title: string; duration: number; thumbnail: string | null; ext: string }
interface YtDlp { version(): Promise<string | null>; probe(url: string): Promise<{ id: string; title: string; duration: number; thumbnail: string | null }>; download(url: string, outDir: string): Promise<string> }
function createApp(opts: { cacheDir: string; ytdlp: YtDlp; staticDir?: string }): express.Express
// POST /api/fetch {url} -> SongMeta | {error}, GET /api/audio/:id, GET /api/status -> {ytdlp: string|null}
```
- [ ] テスト: キャッシュヒット時は download が呼ばれない / 20 分超は 400 / yt-dlp 失敗は 502 で stderr 要点を返す / 同時 2 リクエストで download 1 回 / 不正 id の audio 取得は 400 / spawn 引数で URL が `--` の後
- [ ] 実装 → テスト PASS → Commit

### Task 3: スペクトル解析

**Files:** Create `src/analysis/params.ts`, `src/analysis/spectrum.ts`; Test `test/analysis/spectrum.test.ts`, helper `test/analysis/synth.ts`

**Interfaces:**
```ts
interface Features { frameRate: number; nFrames: number; flux: [Float32Array, Float32Array, Float32Array]; combinedFlux: Float32Array; energy: [Float32Array, Float32Array, Float32Array]; rms: Float32Array }
function computeFeatures(pcm: Float32Array, sr: number): Features
```
- [ ] テスト: 1kHz 正弦で mid 帯域エネルギーが最大、60Hz で low、6kHz で high / フレーム数 = ceil(len/hop)
- [ ] 実装(radix-2 FFT, Hann, 中心化フレーム, log 圧縮フラックス) → PASS → Commit

### Task 4: オンセット検出

**Files:** Create `src/analysis/onsets.ts`; Test `test/analysis/onsets.test.ts`
```ts
interface Onset { t: number; strength: number; band: 0 | 1 | 2 }
function detectOnsets(f: Features): Onset[]   // 時刻順, strength は 0..1 正規化
```
- [ ] テスト: 合成ドラム(キック/スネア/ハイハット)で再現率 ≥90%(±30ms)、帯域が正しい割合 ≥80%、無音で空配列
- [ ] 実装 → PASS → Commit

### Task 5: テンポ・拍

**Files:** Create `src/analysis/tempo.ts`; Test `test/analysis/tempo.test.ts`
```ts
interface Grid { bpm: number; beats: number[]; reliable: boolean; slots: { t: number; sub: 0 | 1 | 2 | 3; beat: number }[] }
function trackBeats(f: Features, duration: number): Grid
```
- [ ] テスト: クリック 95/128/174 BPM で ±1、拍位置誤差 <30ms、ランダム間隔クリックで reliable=false、無音でも例外なし
- [ ] 実装(自己相関 → 90–180 折り返し → Ellis DP → 回帰で BPM 精密化 → 両端外挿で 16 分スロット) → PASS → Commit

### Task 6: 譜面生成

**Files:** Create `src/analysis/chart.ts`, `src/analysis/rng.ts`, `src/analysis/analyze.ts`; Test `test/analysis/chart.test.ts`
```ts
type Difficulty = 'easy' | 'normal' | 'hard'
interface Note { t: number; lane: 0 | 1 | 2 | 3; dur?: number; critical?: boolean }
interface Chart { version: number; bpm: number; gridReliable: boolean; difficulty: Difficulty; notes: Note[] }
interface Analysis { version: number; bpm: number; gridReliable: boolean; duration: number; charts: Record<Difficulty, Chart>; pulse: { frameRate: number; data: Float32Array } }
function generateChart(f: Features, onsets: Onset[], grid: Grid, d: Difficulty, seed: string, duration: number): Chart
function analyze(pcm: Float32Array, sr: number, seed: string): Analysis
```
- [ ] テスト: 決定性 / EASY に同時押しなし、NORMAL の同時押しは拍頭のみ / 同レーン間隔 ≥ 8分 / ロング保持中に同じ手のノーツなし / 4 拍ごとの数が密度上限以内 / ノーツ数 EASY<NORMAL<HARD / 時刻順・範囲内 / 3 秒・無音入力で例外なし
- [ ] 実装 → PASS → Commit

### Task 7: 判定エンジン

**Files:** Create `src/game/judge.ts`; Test `test/game/judge.test.ts`
```ts
type Grade = 'perfect' | 'great' | 'good' | 'miss'
interface JudgeEvent { lane: number; grade: Grade; delta: number; critical: boolean; tail?: boolean }
class Judge { constructor(notes: Note[]); press(lane: number, t: number): JudgeEvent | null; release(lane: number, t: number): JudgeEvent | null; update(t: number): JudgeEvent[]; readonly state: JudgeState }
function rankOf(score: number): 'S' | 'A' | 'B' | 'C'
```
- [ ] テスト: 境界 40/80/120ms、範囲外 press は無視、見逃し MISS、コンボ切断、ロング(早離し MISS / 終点通過で自動成立 / 始点 MISS で終点も MISS)、クリティカル重み、全 PERFECT で 1,000,000、ライフ増減と failed、FC/AP
- [ ] 実装 → PASS → Commit

### Task 8: ブラウザ基盤(clock / input / storage / worker / audio 取得)

**Files:** Create `src/game/clock.ts`, `src/game/hitsound.ts`, `src/storage.ts`, `src/analysis/worker.ts`, `src/loader.ts`
- `SongClock`: `start()`, `pause()`, `resume()`, `now()`, `eventTime(ev.timeStamp)` — getOutputTimestamp で performance 時刻 ⇄ context 時刻を変換、リードイン 2 秒
- `storage`: IndexedDB(songs / analyses / scores / settings / files)、失敗時はメモリにフォールバック
- `loader`: URL → /api/fetch → /api/audio、File → SHA-256 id。decode → OfflineAudioContext で 22050 mono → Worker → Analysis(キャッシュ確認)
- [ ] `npm run build` が型エラーなしで通る → Commit

### Task 9: 描画(透視 4 レーン + 演出)

**Files:** Create `src/game/renderer.ts`
- 射影 `s(z)=1/(1+3z)`、レーン台形、タップ/クリティカル/ロング、ヒットパーティクル、キー押下発光、判定文字・コンボ、ライフ・スコア・進捗、ぼかしサムネ背景 + 低域パルス
- [ ] build 通過 → Commit

### Task 10: 画面と遊びの流れ

**Files:** Create `src/main.ts`, `src/ui/*.ts`, `src/style.css`
- タイトル(URL 入力・ドロップ・履歴/ハイスコア・サーバー状態)、進捗、難易度選択、プレイ(Esc でポーズメニュー)、リザルト(自己ベスト更新)、設定(オフセット自動調整含む)
- [ ] build 通過 → `npm start` で起動し、実際の YouTube URL で取得 → 解析 → 譜面統計を確認 → Commit

### Task 11: 最終検証

- [ ] `npm test` 全 PASS、`npm run build` 成功
- [ ] 実曲 2–3 曲で Node 上の解析(ffmpeg デコード)を流し、BPM・ノーツ数・処理時間を記録
- [ ] ブラウザで画面遷移とプレイを確認(可能な範囲で自動、残りはユーザーの手動確認に回す)
