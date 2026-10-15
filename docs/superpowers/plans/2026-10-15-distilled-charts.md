# ブラウザ内 AI 譜面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** MuG を蒸留した小型モデルをブラウザで動かし、GitHub Pages で完結する AI 譜面を作る。
**Spec:** `docs/superpowers/specs/2026-10-15-distilled-charts-design.md`

## Global Constraints
- 特徴量は TS/Python で一致(最大誤差 1e-3)。音源・手本・学習済み重みの元データはコミットしない
- リグの ai-router / power-proxy は学習中だけ停止し、必ず戻す
- 既存テストは全通過のまま

## Review Focus
- ブラウザの特徴量計算とリサンプル差による精度劣化(テスト曲をブラウザ経路で推論して F1 を比較)
- 長い曲(7 分)でのメモリ・推論時間
- モデル読み込み失敗時のフォールバック

### Task 1: 曲の収集(`ml/collect.py`)
### Task 2: 手本生成(`ml/teacher.sh`、既存 `scripts/mug_cli.py`)
### Task 3: 特徴量(`ml/features.py` と `src/analysis/mel.ts`、一致テスト)
### Task 4: データセット・モデル・学習(`ml/dataset.py`, `ml/model.py`, `ml/train.py`)→ リグで試作学習・F1 評価
### Task 5: ONNX 書き出しと閾値決定(`ml/export.py`)
### Task 6: ブラウザ推論とデコード(`src/analysis/neural.ts`、worker 連携、フォールバック)
### Task 7: 300 曲へ拡大・再学習・評価
### Task 8: GitHub Pages(静的モード、Actions)
