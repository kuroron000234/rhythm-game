# 予想できる譜面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 主役レイヤー・意味のあるレーン・繰り返しコピーで予想できる譜面にし、プロセカ風効果音と差し替え機能を付ける。
**Spec:** `docs/superpowers/specs/2026-10-13-readable-charts-design.md`

## Global Constraints
- 信頼グリッド時は全ノーツがスロット上。乱数不使用。CHART_VERSION を 3 に
- 既存の規則(8 分未満同レーン禁止、ロング中同手禁止、密度上限 ×1.3)維持

## Review Focus
- コピー先の区間境界で規則違反が出ないか(検証パスで削除、テストで確認)
- ロング保持中ループ音が離した時・ポーズ時・リトライ時に止まるか(手動/e2e)
- 差し替え音源が壊れたファイルでも落ちないか(デコード失敗で既定音に戻す)

### Task 1: 主役レイヤー + レーン規則 + 拍揃え
Files: `src/analysis/chart.ts`, `params.ts`; Test `test/analysis/pattern.test.ts`(スロット上・ドラム左右・音程単調)
### Task 2: 繰り返し区間のコピー
Files: `src/analysis/chart.ts`, `sections.ts`; Test pattern.test.ts(サビ一致)
### Task 3: 効果音(合成 3 種 + ロングループ + 差し替え)
Files: `src/game/hitsound.ts`, `src/ui/play.ts`, `src/ui/settings.ts`, `src/ui/app.ts`, `src/storage.ts`
### Task 4: 検証
実曲 3 曲で統計、bot プレイ、e2e
