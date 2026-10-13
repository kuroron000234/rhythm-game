// All tunables for analysis and chart generation live here.
export const SR = 22050;
export const WIN = 2048;
export const HOP = 512;
/** Band edges in Hz: low < 150 <= mid < 2000 <= high. */
export const BAND_EDGES = [150, 2000] as const;

/** Bump whenever analysis/chart output changes so cached charts are regenerated. */
export const CHART_VERSION = 2;

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
  /** AI charts: the density cap is raised so at least this share of sung notes in a group survive. */
  vocalFloor: number;
}

export const DIFFICULTY: Record<'easy' | 'normal' | 'hard', DifficultyParams> = {
  easy: { subs: [0], maxDensity: 3, chords: 'none', chordShare: 0, holds: false, minScore: 0.25, freeGap: 0.3, vocalFloor: 0 },
  normal: { subs: [0, 2], maxDensity: 6, chords: 'strong', chordShare: 0.15, holds: true, minScore: 0.2, freeGap: 0.15, vocalFloor: 0.6 },
  hard: { subs: [0, 1, 2, 3], maxDensity: 10, chords: 'any', chordShare: 0.25, holds: true, minScore: 0.15, freeGap: 0.08, vocalFloor: 1 },
};

/** Onsets snap to a slot when within this fraction of a 16th note. */
export const SNAP_TOLERANCE = 0.4;
export const BEAT_HEAD_BONUS = [0.3, 0, 0.1, 0];
/** Beats per intensity section (4 bars). */
export const SECTION_BEATS = 16;
/** Section length in seconds when there is no reliable beat grid. */
export const SECTION_FREE_SECONDS = 8;
/** strength = rank-blend of LOUD·loudness + DENSITY·onset density + REPEAT·repetition·loudness */
export const SECTION_WEIGHTS = { loud: 0.55, density: 0.25, repeat: 0.2 } as const;
/** Density multiplier = BASE + SPAN × strength (0.3–1.3). */
export const DENSITY_BASE = 0.3;
export const DENSITY_SPAN = 1.0;
export const DENSITY_MAX_FACTOR = DENSITY_BASE + DENSITY_SPAN;
/** Chords: none below WEAK, share ×STRONG_MULT at or above STRONG. */
export const CHORD_WEAK = 0.3;
export const CHORD_STRONG = 0.7;
export const CHORD_STRONG_MULT = 1.5;
export const CRITICAL_MIN_STRENGTH = 0.6;
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

// Vocal note extraction (YIN on the separated vocal stem)
export const VOCAL = {
  win: 1024,
  hop: 256,
  minHz: 80,
  maxHz: 1000,
  yinThreshold: 0.3,
  minConfidence: 0.6,
  /** Voiced frames must be at least this fraction of the stem's 95th-percentile RMS. */
  minLevel: 0.06,
  /** A frame quieter than this fraction of the current note's peak ends the note (syllable gap). */
  dipRatio: 0.35,
  /** Unvoiced-but-loud frames bridged inside a note (pitch tracker dropouts). */
  maxBridge: 6,
  /** Semitones away from the running note pitch (for splitFrames frames) that start a new note. */
  splitSemitones: 0.8,
  splitFrames: 3,
  minFrames: 4,
  /** Fragments shorter than this that touch the previous note (gap ≤ fragmentGap) are merged into it (pitch glides). */
  fragment: 0.1,
  fragmentGap: 0.02,
  /** Short notes this many semitones away from both neighbours are tracker glitches. */
  glitchSemitones: 9,
  glitchMaxDur: 0.15,
  /** Onset refinement: look this far back (s) for the stem's energy rise (consonants precede stable pitch). */
  attackLookback: 0.1,
  attackLookahead: 0.02,
} as const;

// AI (vocal-driven) charts
export const AI = {
  /** Vocal note score = BASE + LEVEL × level. */
  vocalBase: 0.65,
  vocalLevel: 0.35,
  /** Vocal onsets snap to the grid within this fraction of a 16th; further off they stay at their sung time (HARD only). */
  vocalSnap: 0.3,
  /** Ignore very quiet vocal notes (breaths, bleed). */
  vocalMinLevel: 0.08,
  /** Accompaniment onset scores are scaled so vocals win when both are present. */
  accompWeight: 0.7,
  /** Sung notes at least this many beats long become holds. */
  holdMinBeats: 1,
  /** Below this many vocal notes the song is treated as instrumental (energy-based holds). */
  minVocalNotes: 20,
} as const;
