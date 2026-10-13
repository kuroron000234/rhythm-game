import type { App } from './app.ts';
import { h, keyLabel } from './dom.ts';
import { DEFAULT_SETTINGS, storage, type Settings } from '../storage.ts';
import { playHit } from '../game/hitsound.ts';
import { ctxTimeAt } from '../game/clock.ts';

function slider(label: string, value: number, min: number, max: number, step: number, unit: string, onInput: (v: number) => void) {
  const out = h('output', {}, `${value}${unit}`);
  const input = h<HTMLInputElement>('input', { type: 'range', min, max, step, value, oninput: () => {
    out.textContent = `${input.value}${unit}`;
    onInput(Number(input.value));
  } });
  return { row: h('label.setting', {}, h('span', {}, label), input, out), input, out };
}

export function showSettings(app: App, back: () => void) {
  const s: Settings = structuredClone(app.settings);
  const save = () => app.saveSettings(s);

  const speed = slider('ハイスピード', s.speed, 1, 12, 0.5, '', (v) => { s.speed = v; save(); });
  const judge = slider('判定オフセット', s.judgeOffset, -200, 200, 1, 'ms', (v) => { s.judgeOffset = v; save(); });
  const visual = slider('表示オフセット', s.visualOffset, -200, 200, 1, 'ms', (v) => { s.visualOffset = v; save(); });
  const vol = slider('曲の音量', Math.round(s.volume * 100), 0, 100, 1, '%', (v) => { s.volume = v / 100; save(); });
  const hitVol = slider('ヒット音の音量', Math.round(s.hitVolume * 100), 0, 100, 1, '%', (v) => { s.hitVolume = v / 100; save(); });
  const hitToggle = h<HTMLInputElement>('input', { type: 'checkbox', checked: s.hitSound, onchange: () => { s.hitSound = hitToggle.checked; save(); } });

  let binding = -1;
  const keyButtons = s.keys.map((code, i) => h('button.key', { onclick: () => {
    binding = i;
    keyButtons.forEach((b, j) => b.classList.toggle('active', j === i));
    keyButtons[i].textContent = '…';
  } }, keyLabel(code)));

  // custom hit sounds (the player's own files; nothing is bundled)
  const soundRow = (key: 'tap' | 'critical', label: string) => {
    const status = h('span.muted', {}, '');
    const refresh = async () => { status.textContent = (await storage.getFile(`se:${key}`)) ? '自分のファイル' : '内蔵の音'; };
    const input = h<HTMLInputElement>('input', { type: 'file', accept: 'audio/*', hidden: true, onchange: async () => {
      const f = input.files?.[0];
      if (!f) return;
      const bytes = await f.arrayBuffer();
      try { await app.ctx.decodeAudioData(bytes.slice(0)); } catch { status.textContent = '読み込めない形式です'; return; }
      await storage.putFile(`se:${key}`, bytes);
      await app.loadCustomSounds();
      refresh();
      playHit(app.ctx, app.sounds[key], s.hitVolume);
    } });
    refresh();
    return h('div.setting', {}, h('span', {}, label),
      h('div.sound-buttons', {},
        h('button', { onclick: async () => { await app.unlockAudio(); playHit(app.ctx, app.sounds[key], s.hitVolume); } }, '試聴'),
        h('button', { onclick: () => input.click() }, 'ファイルを選ぶ'),
        h('button.ghost', { onclick: async () => { await storage.deleteFile(`se:${key}`); await app.loadCustomSounds(); refresh(); } }, '内蔵に戻す'),
        input),
      status);
  };

  const calibStatus = h('div.muted', {}, 'クリック音に合わせて Space を 16 回叩くと、判定オフセットを自動で設定します');
  const calibButton = h('button', { onclick: () => calibrate() }, 'オフセット自動調整');
  let calibrating: { clicks: number[]; deltas: number[] } | null = null;

  async function calibrate() {
    await app.unlockAudio();
    const beat = 0.5;
    const t0 = app.ctx.currentTime + 1;
    const clicks: number[] = [];
    for (let i = 0; i < 20; i++) {
      const src = app.ctx.createBufferSource();
      src.buffer = app.sounds.tap;
      const g = app.ctx.createGain();
      g.gain.value = 0.8;
      src.connect(g).connect(app.ctx.destination);
      src.start(t0 + i * beat);
      clicks.push(t0 + i * beat);
    }
    calibrating = { clicks, deltas: [] };
    calibStatus.textContent = '4 回目のクリックから Space で叩いてください…';
    setTimeout(finishCalibration, (1 + 20 * beat + 0.5) * 1000);
  }

  function finishCalibration() {
    if (!calibrating) return;
    const d = calibrating.deltas.slice().sort((a, b) => a - b);
    calibrating = null;
    if (d.length < 6) { calibStatus.textContent = '入力が少なすぎました。もう一度試してください'; return; }
    const median = d[d.length >> 1];
    s.judgeOffset = Math.round(median * 1000);
    judge.input.value = String(s.judgeOffset);
    judge.out.textContent = `${s.judgeOffset}ms`;
    save();
    calibStatus.textContent = `判定オフセットを ${s.judgeOffset}ms に設定しました (${d.length} 回の入力)`;
  }

  const root = h('div.screen.settings', {},
    h('button.ghost.back', { onclick: back }, '← 戻る'),
    h('h2', {}, '設定'),
    speed.row, judge.row,
    h('div.setting', {}, calibButton, calibStatus),
    visual.row, vol.row,
    h('label.setting', {}, h('span', {}, 'ヒット音'), hitToggle),
    hitVol.row,
    soundRow('tap', 'タップ音'),
    soundRow('critical', 'クリティカル音'),
    h('div.setting', {}, h('span', {}, 'キー配置'), h('div.keys', {}, ...keyButtons)),
    h('button.ghost', { onclick: () => { Object.assign(s, structuredClone(DEFAULT_SETTINGS)); save(); showSettings(app, back); } }, '初期設定に戻す'),
  );

  app.show(root, {
    keydown: (e) => {
      if (binding >= 0) {
        e.preventDefault();
        if (e.code !== 'Escape') {
          const other = s.keys.indexOf(e.code);
          if (other >= 0 && other !== binding) s.keys[other] = s.keys[binding];
          s.keys[binding] = e.code;
          save();
        }
        binding = -1;
        keyButtons.forEach((b, j) => { b.classList.remove('active'); b.textContent = keyLabel(s.keys[j]); });
        return;
      }
      if (calibrating && e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        const t = ctxTimeAt(app.ctx, e.timeStamp);
        const near = calibrating.clicks.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
        if (calibrating.clicks.indexOf(near) >= 3 && Math.abs(t - near) < 0.2) calibrating.deltas.push(t - near);
        return;
      }
      if (e.code === 'Escape') back();
    },
  });
}
