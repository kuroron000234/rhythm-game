// All tunables for analysis and chart generation live here.
export const SR = 22050;
export const WIN = 2048;
export const HOP = 512;
/** Band edges in Hz: low < 150 <= mid < 2000 <= high. */
export const BAND_EDGES = [150, 2000] as const;

/** Bump whenever analysis/chart output changes so cached charts are regenerated. */
export const CHART_VERSION = 1;
