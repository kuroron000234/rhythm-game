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
/** Grid counts as reliable when the ACF peak stands out, beat intervals are stable and onsets sit on the 16th grid. */
export const GRID_MIN_PROMINENCE = 2.0;
export const GRID_MAX_CV = 0.05;
export const GRID_ALIGN_TOL = 0.025;
export const GRID_MIN_ALIGNMENT = 0.75;
