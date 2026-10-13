import './style.css';
import { App } from './ui/app.ts';
import { showTitle } from './ui/title.ts';
import { showSelect } from './ui/select.ts';
import { showPlay } from './ui/play.ts';
import { showResult } from './ui/result.ts';
import { showSettings } from './ui/settings.ts';
import type { LoadedSong } from './loader.ts';
import type { Difficulty } from './analysis/chart.ts';

const app = await App.create();

const title = () => showTitle(app, { select, settings: () => showSettings(app, title) });
const select = (song: LoadedSong) => showSelect(app, song, { play: (d) => play(song, d), back: title });
const play = (song: LoadedSong, d: Difficulty) =>
  showPlay(app, song, d, {
    result: (r) => showResult(app, song, r, { retry: () => play(song, d), select: () => select(song), title }),
    select: () => select(song),
  });

title();
