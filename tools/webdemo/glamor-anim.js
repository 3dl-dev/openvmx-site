// glamor-anim.js — capture the boot -> login -> SHOW USERS sequence as frames,
// then assemble MP4 + GIF. Drives the fixed amber harness (glamor-index.html) in
// a taller classic-VMS terminal, starts capturing the moment the OVMX startup
// dialog appears (skips the silent kernel boot), paces the login and command so
// they read as motion, and screenshots #terminal each tick. Real guest output.
//
//   node glamor-anim.js <base-url> <frames-dir>
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://localhost:8100';
const FRAMES = path.resolve(process.argv[3] || 'anim-frames');
const COLS = +(process.env.ANIM_COLS || 88);
const ROWS = +(process.env.ANIM_ROWS || 24);
const FS = +(process.env.ANIM_FS || 17);
const TICK = +(process.env.ANIM_TICK || 340);       // ms between frames
const BOOT_TIMEOUT_S = +(process.env.ANIM_BOOT_S || 320);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readScreen = (p) => p.evaluate(() => {
  const t = window.__ovmxTerm; if (!t) return '';
  const b = t.buffer.active; let s = '';
  for (let j = 0; j < b.length; j++) { const l = b.getLine(j); if (l) s += l.translateToString(true) + '\n'; }
  return s;
});
const lastLine = (s) => { const a = s.split('\n').filter((x) => x.trim()); return (a[a.length - 1] || '').trim(); };

(async () => {
  fs.rmSync(FRAMES, { recursive: true, force: true }); fs.mkdirSync(FRAMES, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'], executablePath: process.env.CHROME_BIN || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGEERR', e.message));

  const url = `${BASE}/glamor-index.html?cols=${COLS}&rows=${ROWS}&fs=${FS}`;
  console.log('cold-booting:', url);
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ovmxTerm, { timeout: 30000 });
  const term = page.locator('#terminal');

  // Wait (uncaptured) for the startup dialog — skip the silent kernel boot.
  console.log('waiting for startup dialog…');
  for (let i = 0; i < BOOT_TIMEOUT_S * 4; i++) {
    if (/%OVMX-I-EXEC|SYSKRNL|executive attached/.test(await readScreen(page))) break;
    await sleep(250);
  }
  await page.click('#terminal');

  // Tick loop: screenshot every TICK ms and advance a login state machine, so the
  // dialog scroll, the typing, and SHOW USERS are all captured as motion.
  let n = 0, state = 'WAKE', queue = [], wakeAt = 0;
  const snap = async () => { await term.screenshot({ path: path.join(FRAMES, `f${String(n).padStart(4, '0')}.png`) }); n++; };
  const enqueue = (s) => { queue = s.split(''); };
  let hold = 0, guard = 0;
  while (guard++ < 400) {
    await snap();
    const scr = await readScreen(page);
    if (state === 'WAKE') {
      if (/Username:/.test(scr)) { state = 'TYPE_USER'; enqueue('system\r'); }
      else if (n - wakeAt >= 4) { await page.keyboard.press('Enter'); wakeAt = n; }
    } else if (state === 'TYPE_USER' || state === 'TYPE_PW' || state === 'TYPE_CMD') {
      if (queue.length) { const c = queue.shift(); if (c === '\r') await page.keyboard.press('Enter'); else await page.keyboard.type(c); }
      else if (state === 'TYPE_USER') state = 'WAIT_PW';
      else if (state === 'TYPE_PW') state = 'WAIT_PROMPT';
      else { state = 'HOLD'; hold = 10; }
    } else if (state === 'WAIT_PW') {
      if (/Password:/.test(scr)) { state = 'TYPE_PW'; enqueue('MANAGER\r'); }
    } else if (state === 'WAIT_PROMPT') {
      if (lastLine(scr) === '$') { state = 'TYPE_CMD'; enqueue('SHOW USERS\r'); }
    } else if (state === 'HOLD') {
      if (--hold <= 0) break;
    }
    await sleep(TICK);
  }
  console.log(`captured ${n} frames -> ${FRAMES}`);
  await browser.close();
})().catch((e) => { console.error('ANIM FATAL', e.message); process.exit(1); });
