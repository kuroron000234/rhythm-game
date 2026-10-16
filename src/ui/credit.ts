import { h } from './dom.ts';
import type { SongEntry } from '../storage.ts';

/** Artist credit with a link to the track page, for songs streamed from Audius. */
export function credit(entry: SongEntry): HTMLElement | null {
  if (entry.source !== 'audius') return null;
  return h('div.credit', {},
    `♪ ${entry.artist ?? ''} · `,
    h('a', { href: entry.link ?? 'https://audius.co', target: '_blank', rel: 'noopener' }, 'Audius で聴く'));
}
