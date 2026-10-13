import { describe, it, expect } from 'vitest';
import { Judge, rankOf } from '../../src/game/judge.ts';
import type { Note } from '../../src/analysis/chart.ts';

const tap = (t: number, lane: 0 | 1 | 2 | 3 = 0, critical = false): Note => ({ t, lane, ...(critical ? { critical } : {}) });

describe('Judge', () => {
  it('grades by timing window boundaries', () => {
    const cases: [number, string][] = [[0, 'perfect'], [0.04, 'perfect'], [-0.0401, 'great'], [0.08, 'great'], [0.0801, 'good'], [-0.12, 'good']];
    for (const [d, g] of cases) {
      const j = new Judge([tap(1)]);
      expect(j.press(0, 1 + d)?.grade).toBe(g);
    }
  });

  it('ignores presses outside the good window and on other lanes', () => {
    const j = new Judge([tap(1)]);
    expect(j.press(0, 0.85)).toBeNull();
    expect(j.press(1, 1)).toBeNull();
    expect(j.press(0, 1)?.grade).toBe('perfect');
    expect(j.press(0, 1.01)).toBeNull(); // already judged
  });

  it('takes the earliest unjudged note in the window', () => {
    const j = new Judge([tap(1), tap(1.1)]);
    expect(j.press(0, 1.06)?.delta).toBeCloseTo(0.06);
    expect(j.press(0, 1.1)?.delta).toBeCloseTo(0);
  });

  it('misses notes that pass the window and breaks the combo', () => {
    const j = new Judge([tap(1), tap(2), tap(3)]);
    j.press(0, 1);
    j.press(0, 2);
    expect(j.state.combo).toBe(2);
    expect(j.update(3.11)).toEqual([]);
    const ev = j.update(3.121);
    expect(ev.map((e) => e.grade)).toEqual(['miss']);
    expect(j.state.combo).toBe(0);
    expect(j.state.maxCombo).toBe(2);
    expect(j.finished).toBe(true);
    expect(j.state.fullCombo).toBe(false);
  });

  it('scores 1,000,000 for all perfect and weights criticals double', () => {
    const j = new Judge([tap(1), tap(2, 1, true)]);
    j.press(0, 1);
    j.press(1, 2);
    expect(j.state.score).toBe(1_000_000);
    expect(j.state.allPerfect).toBe(true);
    const k = new Judge([tap(1), tap(2, 1, true)]);
    k.press(0, 1);
    k.update(3); // critical missed: 1 of 3 weight earned
    expect(k.state.score).toBe(333_333);
    const g = new Judge([tap(1), tap(2)]);
    g.press(0, 1.06); // great 0.7
    g.press(0, 2.1); // good 0.4
    expect(g.state.score).toBe(550_000);
  });

  describe('holds', () => {
    const hold: Note = { t: 1, lane: 2, dur: 1 };
    it('succeeds when held to the end (auto-complete)', () => {
      const j = new Judge([hold]);
      expect(j.press(2, 1)?.grade).toBe('perfect');
      expect(j.update(1.5)).toEqual([]);
      const ev = j.update(2.0);
      expect(ev).toMatchObject([{ grade: 'perfect', tail: true }]);
      expect(j.state.score).toBe(1_000_000);
      expect(j.state.combo).toBe(2);
    });
    it('accepts a release within 120ms of the end', () => {
      const j = new Judge([hold]);
      j.press(2, 1);
      expect(j.release(2, 1.885)).toMatchObject({ grade: 'perfect', tail: true });
    });
    it('misses the tail on an early release', () => {
      const j = new Judge([hold]);
      j.press(2, 1);
      expect(j.release(2, 1.5)).toMatchObject({ grade: 'miss', tail: true });
      expect(j.state.combo).toBe(0);
      expect(j.update(3)).toEqual([]);
    });
    it('misses both ends when the head is missed', () => {
      const j = new Judge([hold]);
      expect(j.update(1.2).map((e) => e.grade)).toEqual(['miss', 'miss']);
      expect(j.finished).toBe(true);
    });
  });

  it('tracks life: −8 per miss, +1 per perfect, clamped, and remembers failing', () => {
    const notes = Array.from({ length: 14 }, (_, i) => tap(i + 1));
    const j = new Judge(notes);
    j.press(0, 1);
    expect(j.state.life).toBe(100);
    j.update(13.2); // 12 misses → 100 - 96 = 4
    expect(j.state.life).toBe(4);
    j.update(14.2); // one more → clamps at 0
    expect(j.state.life).toBe(0);
    expect(j.state.failed).toBe(true);
  });

  it('gives +0.5 life for great and 0 for good', () => {
    const j = new Judge([tap(1), tap(2), tap(3), tap(4)]);
    j.update(1.2); // miss → 92
    j.press(0, 2.06); // great → 92.5
    j.press(0, 3.1); // good → 92.5
    expect(j.state.life).toBe(92.5);
  });

  it('counts judgments', () => {
    const j = new Judge([tap(1), tap(2), tap(3)]);
    j.press(0, 1);
    j.press(0, 2.06);
    j.update(4);
    expect(j.state.counts).toEqual({ perfect: 1, great: 1, good: 0, miss: 1 });
  });
});

describe('rankOf', () => {
  it('uses S/A/B/C thresholds', () => {
    expect(rankOf(950_000)).toBe('S');
    expect(rankOf(949_999)).toBe('A');
    expect(rankOf(900_000)).toBe('A');
    expect(rankOf(800_000)).toBe('B');
    expect(rankOf(799_999)).toBe('C');
  });
});
