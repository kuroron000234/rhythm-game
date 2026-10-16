import { describe, expect, it } from 'vitest';
import { fetchAudio, fetchTrack, MAX_DURATION_S, playable, searchTracks, toTrack } from '../src/audius.ts';

const raw = (over: Record<string, unknown> = {}) => ({
  id: 'abc12', title: 'Song', duration: 200, permalink: '/artist/song-1', is_streamable: true,
  access: { stream: true }, artwork: { '150x150': 'https://img/150.jpg', '480x480': 'https://img/480.jpg', mirrors: ['x'] },
  user: { name: 'Artist', handle: 'artist' }, ...over,
});

const fakeFetch = (routes: Record<string, unknown>, seen: string[] = []) =>
  (async (url: string) => {
    seen.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('nope', { status: 404 });
    const body = routes[key];
    return body instanceof ArrayBuffer ? new Response(body) : Response.json(body);
  }) as unknown as typeof fetch;

describe('audius', () => {
  it('keeps only public, freely streamable tracks of a playable length', () => {
    expect(playable(raw())).toBe(true);
    expect(playable(raw({ is_streamable: false }))).toBe(false);
    expect(playable(raw({ access: { stream: false } }))).toBe(false);
    expect(playable(raw({ is_stream_gated: true }))).toBe(false);
    expect(playable(raw({ is_delete: true }))).toBe(false);
    expect(playable(raw({ is_unlisted: true }))).toBe(false);
    expect(playable(raw({ duration: 10 }))).toBe(false);
    expect(playable(raw({ duration: MAX_DURATION_S + 1 }))).toBe(false);
  });

  it('maps artist, artwork and a public link', () => {
    expect(toTrack(raw())).toEqual({
      id: 'abc12', title: 'Song', artist: 'Artist', duration: 200, artwork: 'https://img/480.jpg', link: 'https://audius.co/artist/song-1',
    });
    expect(toTrack(raw({ artwork: null })).artwork).toBeNull();
  });

  it('searches with the app name and filters results', async () => {
    const seen: string[] = [];
    const f = fakeFetch({ '/tracks/search': { data: [raw(), raw({ id: 'gated', is_stream_gated: true })] } }, seen);
    const res = await searchTracks(' ミク 曲 ', f);
    expect(res.map((t) => t.id)).toEqual(['abc12']);
    expect(seen[0]).toContain(`query=${encodeURIComponent('ミク 曲')}`);
    expect(seen[0]).toContain('app_name=AUTOBEAT');
  });

  it('returns nothing for an empty query without calling the API', async () => {
    const seen: string[] = [];
    expect(await searchTracks('   ', fakeFetch({}, seen))).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('looks up a track again for history and rejects tracks that became unplayable', async () => {
    expect((await fetchTrack('abc12', fakeFetch({ '/tracks/abc12': { data: raw() } }))).title).toBe('Song');
    await expect(fetchTrack('abc12', fakeFetch({ '/tracks/abc12': { data: raw({ is_delete: true }) } }))).rejects.toThrow();
  });

  it('downloads the audio from the stream endpoint', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const seen: string[] = [];
    const out = await fetchAudio('abc12', fakeFetch({ '/tracks/abc12/stream': bytes }, seen));
    expect(new Uint8Array(out)).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen[0]).toContain('app_name=AUTOBEAT');
  });
});
