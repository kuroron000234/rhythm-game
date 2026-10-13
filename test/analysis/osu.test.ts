import { describe, it, expect } from 'vitest';
import { parseOsuMania, chartFromOsu } from '../../src/analysis/osu.ts';

const OSU = `osu file format v14

[Difficulty]
CircleSize:4

[TimingPoints]
1000,500,4,2,1,20,1,0

[HitObjects]
64,192,1003,1,0,0:0:0:0:
192,192,1251,1,0,0:0:0:0:
320,192,1500,128,0,2490:0:0:0:0:
448,192,1500,1,0,0:0:0:0:
448,192,1530,1,0,0:0:0:0:
64,192,2000,1,0,0:0:0:0:
192,192,2000,1,0,0:0:0:0:
320,192,2100,1,0,0:0:0:0:
448,192,2333,1,0,0:0:0:0:
64,192,2790,1,0,0:0:0:0:
`;

// beats every 0.5s from 1.0s (120 BPM)
const beats = Array.from({ length: 40 }, (_, i) => 1 + i * 0.5);

describe('parseOsuMania', () => {
  it('reads columns, times and long-note ends', () => {
    const n = parseOsuMania(OSU);
    expect(n.length).toBe(10);
    expect(n[0]).toEqual({ t: 1.003, lane: 0 });
    expect(n[2]).toEqual({ t: 1.5, lane: 2, dur: 0.99 });
    expect(n[3].lane).toBe(3);
  });
  it('rejects non-4K charts', () => {
    expect(() => parseOsuMania(OSU.replace('CircleSize:4', 'CircleSize:7'))).toThrow();
  });
});

describe('chartFromOsu', () => {
  const c = chartFromOsu(parseOsuMania(OSU), beats, 'hard', 120);

  it('snaps notes to the 16th grid', () => {
    expect(c.notes[0].t).toBe(1);
    expect(c.notes.find((n) => n.lane === 1)!.t).toBe(1.25);
    const hold = c.notes.find((n) => n.dur)!;
    expect(hold.t).toBe(1.5);
    expect(hold.dur).toBeCloseTo(1.0, 3); // end 2.49 snaps to 2.5
  });

  it('drops same-lane notes that crowd each other', () => {
    expect(c.notes.filter((n) => n.lane === 3 && n.t < 1.6).length).toBe(1);
  });

  it('drops a note inside a held lane', () => {
    expect(c.notes.some((n) => n.lane === 2 && n.t > 1.5 && n.t < 2.5)).toBe(false);
  });

  it('snaps triplets to the triplet grid', () => {
    expect(c.notes.some((n) => n.lane === 3 && Math.abs(n.t - (2 + 1 / 3)) < 0.001)).toBe(true);
  });

  it('leaves notes far from any grid position where they are', () => {
    expect(c.notes.some((n) => n.lane === 0 && Math.abs(n.t - 2.79) < 0.001)).toBe(true);
  });

  it('marks a spaced-out chord on the beat as critical', () => {
    const crit = c.notes.filter((n) => n.critical);
    expect(crit.length).toBeGreaterThan(0);
    for (const n of crit) expect(c.notes.filter((m) => m.t === n.t).length).toBeGreaterThan(1);
  });

  it('carries chart metadata', () => {
    expect(c).toMatchObject({ difficulty: 'hard', bpm: 120, gridReliable: true });
    for (let i = 1; i < c.notes.length; i++) expect(c.notes[i].t).toBeGreaterThanOrEqual(c.notes[i - 1].t);
  });
});
