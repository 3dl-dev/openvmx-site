// verify.js — gate the deploy: boot the REAL demo payload (boot/index.html +
// the freshly-captured snapshot + our qemu-wasm) in headless Chromium, let it
// resume, and assert the OVMX STARTUP DIALOG actually replays (not just that a
// Username: prompt shows). This catches a snapshot mistakenly saved at Username
// (the old bug), a snapshot that won't loadvm in wasm, or a broken reveal —
// before track-release commits it to the live site.
//
//   node verify.js <base-url>     (serves the demo boot/ dir)
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8098';
const TIMEOUT_S = +(process.env.VERIFY_TIMEOUT_S || 260);
// The startup dialog must appear (proves we resumed BEFORE it, at the handoff);
// then the real login prompt.
const STARTUP = /%OVMX-I-EXEC|%STARTUP-I-MOUNTED|vms: /;
const LOGIN = /Username:/;

const readScreen = (p) => p.evaluate(() => {
  const t = window.__ovmxTerm; if (!t) return '';
  const b = t.buffer.active; let s = '';
  for (let j = 0; j < b.length; j++) { const l = b.getLine(j); if (l) s += l.translateToString(true) + '\n'; }
  return s;
});

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.CHROME_BIN || undefined });
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.error('PAGEERR', e.message));
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 20000 });

  let sawStartup = false, sawLogin = false;
  for (let i = 0; i < TIMEOUT_S * 4; i++) {
    const s = await readScreen(page);
    if (STARTUP.test(s)) sawStartup = true;         // latch — the dialog scrolls
    if (LOGIN.test(s)) sawLogin = true;
    if (sawStartup && sawLogin) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await browser.close();
  if (!sawStartup) { console.error('VERIFY FAIL: startup dialog never replayed (snapshot likely at Username, or reveal broke)'); process.exit(1); }
  if (!sawLogin)   { console.error('VERIFY FAIL: reached startup but never the Username: prompt'); process.exit(2); }
  console.log('VERIFY OK: startup dialog replayed and reached Username:');
})().catch((e) => { console.error('VERIFY FATAL', e.message); process.exit(3); });
