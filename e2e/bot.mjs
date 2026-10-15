// Headless end-to-end check: load a song, wait for charts, autoplay a difficulty, report timings/judgements.
// node e2e/bot.mjs <audio file> [hard|normal|easy] [seconds to play] [screenshot dir]
import { chromium } from 'playwright';

const [file, diff = 'hard', seconds = '25', shots] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
await page.goto(process.env.RG_URL ?? 'http://127.0.0.1:5173/?debug');
const t0 = Date.now();
await page.setInputFiles('input[type=file]', file);
await page.waitForSelector('.select', { timeout: 120000 });
const badge = (await page.locator('.ai-badge').isVisible()) ? await page.locator('.ai-badge').textContent() : '(none)';
console.log(`select screen after ${Date.now() - t0} ms; badge: ${badge}; counts: ${(await page.locator('.card .count').allTextContents()).join(' / ')}`);
if (shots) await page.screenshot({ path: `${shots}/select.png` });
await page.locator('.card').nth({ easy: 0, normal: 1, hard: 2 }[diff]).click();
await page.waitForFunction(() => window.__rg);
const stats = await page.evaluate((limit) => new Promise((done) => {
  const { notes, keys, now } = window.__rg;
  let i = 0;
  const step = () => {
    const t = now();
    while (i < notes.length && notes[i].t <= t) {
      const n = notes[i++];
      if (n.t > limit) { const st = window.__rg.state; done({ counts: { ...st.counts }, maxCombo: st.maxCombo }); return; }
      window.dispatchEvent(new KeyboardEvent('keydown', { code: keys[n.lane] }));
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: keys[n.lane] })), (n.dur ?? 0) * 1000 + 30);
    }
    if (i >= notes.length) { const st = window.__rg.state; done({ counts: { ...st.counts }, maxCombo: st.maxCombo }); return; }
    requestAnimationFrame(step);
  };
  step();
}), Number(seconds));
if (shots) await page.screenshot({ path: `${shots}/play.png` });
console.log(`${diff} bot (first ${seconds}s): ${JSON.stringify(stats)}`);
console.log('errors:', errors.join('\n') || 'none');
await browser.close();
