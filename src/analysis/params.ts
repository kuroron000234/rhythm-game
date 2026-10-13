// All tunables for analysis and chart generation live here.
export const SR = 22050;
export const WIN = 2048;
export const HOP = 512;
/** Band edges in Hz: low < 150 <= mid < 2000 <= high. */
export const BAND_EDGES = [150, 2000] as const;

/** Bump whenever analysis/chart output changes so cached charts are regenerated. */
export const CHART_VERSION = 1;

// Onset detection
/** Half-width of the adaptive threshold window, in seconds. */
export const ONSET_WINDOW = 0.5;
export const ONSET_DELTA = 0.2;
export const ONSET_LAMBDA = 1.0;
/** A peak must be the maximum within ±this many frames. */
export const ONSET_PEAK_RADIUS = 3;
export const ONSET_MIN_GAP = 0.05;
/** Bands whose 99th-percentile flux is below this are treated as silent. */
export const ONSET_SILENCE = 1e-3;
/** Centred frames see an onset slightly early; measured ≈12–21ms on synthetic drums. */
export const ONSET_LAG = 0.015;

// Tempo / beat tracking
export const BPM_SEARCH = [60, 240] as const;
export const BPM_FOLD = [90, 180] as const;
export const DEFAULT_BPM = 120;
/** Ellis DP tightness: higher = stricter tempo. */
export const BEAT_TIGHTNESS = 100;
/** Grid counts as reliable when beat intervals are stable and onsets sit on the 16th grid.
 * (ACF peak prominence was tried too: dense real mixes score only ~1.1–1.4, so it is not used.) */
export const GRID_MAX_CV = 0.05;
export const GRID_ALIGN_TOL = 0.025;
export const GRID_MIN_ALIGNMENT = 0.75;

// Chart generation
export interface DifficultyParams {
  /** Allowed slot subdivisions (0 = beat, 2 = 8th, 1/3 = 16ths). */
  subs: number[];
  /** Target maximum notes per second (before the intensity factor). */
  maxDensity: number;
  chords: 'none' | 'strong' | 'any';
  /** Fraction of the strongest candidates that become chords. */
  chordShare: number;
  holds: boolean;
  minScore: number;
  /** Minimum gap between notes when the grid is unreliable (seconds). */
  freeGap: number;
}

export const DIFFICULTY: Record<'easy' | 'normal' | 'hard', DifficultyParams> = {
  easy: { subs: [0], maxDensity: 3, chords: 'none', chordShare: 0, holds: false, minScore: 0.25, freeGap: 0.3 },
  normal: { subs: [0, 2], maxDensity: 6, chords: 'strong', chordShare: 0.15, holds: true, minScore: 0.2, freeGap: 0.15 },
  hard: { subs: [0, 1, 2, 3], maxDensity: 10, chords: 'any', chordShare: 0.25, holds: true, minScore: 0.15, freeGap: 0.08 },
};

/** Onsets snap to a slot when within this fraction of a 16th note. */
export const SNAP_TOLERANCE = 0.4;
export const BEAT_HEAD_BONUS = [0.3, 0, 0.1, 0];
/** Section intensity scales density between these bounds. */
export const INTENSITY_RANGE = [0.5, 1.15] as const;
/** Beats per intensity section (4 bars). */
export const SECTION_BEATS = 16;
export const HOLD_MIN_BEATS = 2;
export const HOLD_MAX_BEATS = 4;
/** Energy must stay above this fraction of its start level to count as sustained. */
export const HOLD_SUSTAIN_RATIO = 0.5;
export const HOLD_MAX_SHARE = 0.15;
/** Seconds after the onset where the sustain reference level is taken. */
export const HOLD_REF_DELAY = 0.12;
/** The reference level must exceed this percentile of mid-band energy. */
export const HOLD_MIN_LOUDNESS = 0.6;
export const CRITICAL_SHARE = 0.03;
export const CRITICAL_MIN_GAP_BEATS = 8;
