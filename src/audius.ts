/**
 * Song search through the public Audius API (https://docs.audius.co).
 *
 * Audius API Terms (https://audius.co/legal/api-terms) apply to tracks loaded this way:
 * - audio and anything derived from it is cached for the current session only (see loader.prepare), never in IndexedDB;
 * - Audius audio must never be used to train models (the ml/ pipeline only reads local files);
 * - the app shows the artist, a link to the track, and links to the Audius privacy policy and API terms.
 */
export const AUDIUS_API = 'https://api.audius.co/v1';
export const AUDIUS_APP = 'AUTOBEAT';
export const AUDIUS_TERMS_URL = 'https://audius.co/legal/api-terms';
export const AUDIUS_PRIVACY_URL = 'https://audius.co/legal/privacy-policy';

/** Longest track offered in search results (charts for very long mixes are not fun and analysis gets slow). */
export const MAX_DURATION_S = 10 * 60;

export interface AudiusTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  artwork: string | null;
  /** Public page of the track on audius.co. */
  link: string;
}

interface RawTrack {
  id: string;
  title: string;
  duration: number;
  permalink?: string;
  is_streamable?: boolean;
  is_stream_gated?: boolean;
  is_delete?: boolean;
  is_unlisted?: boolean;
  access?: { stream?: boolean };
  artwork?: Record<string, string | string[]> | null;
  user: { name: string; handle: string };
}

const withApp = (url: string) => `${url}${url.includes('?') ? '&' : '?'}app_name=${AUDIUS_APP}`;

/** Only freely streamable, public tracks of a playable length. */
export function playable(t: RawTrack): boolean {
  return !!t.is_streamable && t.access?.stream !== false && !t.is_stream_gated && !t.is_delete && !t.is_unlisted
    && t.duration > 20 && t.duration <= MAX_DURATION_S;
}

export function toTrack(t: RawTrack): AudiusTrack {
  const art = t.artwork?.['480x480'] ?? t.artwork?.['150x150'];
  return {
    id: t.id,
    title: t.title,
    artist: t.user.name,
    duration: t.duration,
    artwork: typeof art === 'string' ? art : null,
    link: `https://audius.co${t.permalink ?? `/${t.user.handle}`}`,
  };
}

export async function searchTracks(query: string, fetchFn: typeof fetch = fetch): Promise<AudiusTrack[]> {
  const q = query.trim();
  if (!q) return [];
  const r = await fetchFn(withApp(`${AUDIUS_API}/tracks/search?query=${encodeURIComponent(q)}&limit=30`));
  if (!r.ok) throw new Error(`Audius search failed (${r.status})`);
  const { data } = (await r.json()) as { data: RawTrack[] };
  return (data ?? []).filter(playable).map(toTrack);
}

export async function fetchTrack(id: string, fetchFn: typeof fetch = fetch): Promise<AudiusTrack> {
  const r = await fetchFn(withApp(`${AUDIUS_API}/tracks/${encodeURIComponent(id)}`));
  if (!r.ok) throw new Error(`Audius track lookup failed (${r.status})`);
  const { data } = (await r.json()) as { data: RawTrack };
  if (!playable(data)) throw new Error('This track can no longer be streamed');
  return toTrack(data);
}

/** Full audio of a track (the stream endpoint redirects to a CORS-enabled content node). */
export async function fetchAudio(id: string, fetchFn: typeof fetch = fetch): Promise<ArrayBuffer> {
  const r = await fetchFn(withApp(`${AUDIUS_API}/tracks/${encodeURIComponent(id)}/stream`));
  if (!r.ok) throw new Error(`Audius stream failed (${r.status})`);
  return r.arrayBuffer();
}
