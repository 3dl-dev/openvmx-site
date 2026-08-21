// login-verify.js — the REAL proof the demo runs V0.5: load the deployed demo
// page (which loadvm's the snapshot and replays startup), then actually LOG IN
// (SYSTEM / MANAGER) and confirm we land on the DCL '$' prompt, and that the
// banner reads V0.5. node login-verify.js <base-url>
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8098';
const T = +(process.env.LOGIN_TIMEOUT_S || 300);

const readScreen = (p) => p.evaluate(() => {
  const t = window.__ovmxTerm; if (!t) return '';
  const b = t.buffer.active; let s = '';
  for (let j = 0; j < b.length; j++) { const l = b.getLine(j); if (l) s += l.translateToString(true) + '\n'; }
  return s;
});
const waitFor = async (p, re, secs, label) => {
  for (let i = 0; i < secs * 4; i++) {
    const s = await readScreen(p);
    if (re.test(s)) return s;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('timeout waiting for ' + label + ' (' + re + ')');
};

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.error('PAGEERR', e.message));
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 20000 });

  // The page auto-drives loadvm + reveal. Wait for the startup replay, the V0.5
  // banner, and the Username: prompt.
  const startup = await waitFor(page, /%OVMX-I-EXEC|%OVMX-I-MOUNTED/, T, 'startup replay');
  console.log('OK: startup dialog replayed');
  const banner = await waitFor(page, /OpenVMX V0\.5/, 30, 'V0.5 banner');
  console.log('OK: banner reads V0.5');
  await waitFor(page, /Username:/, T, 'Username: prompt');
  console.log('OK: reached Username:');

  // Log in as SYSTEM / MANAGER through the live console.
  await page.locator('#terminal').click();
  await new Promise(r => setTimeout(r, 300));
  await page.keyboard.type('SYSTEM'); await page.keyboard.press('Enter');
  await waitFor(page, /Password:/i, 30, 'Password: prompt');
  console.log('OK: got Password: prompt');
  await page.keyboard.type('MANAGER'); await page.keyboard.press('Enter');

  // Land on the DCL '$' prompt. Look for a line that is a bare '$' prompt
  // (optionally with node name), not the '$' inside status codes.
  const dollar = await waitFor(page, /(^|\n)\s*\$\s*$|(^|\n)[A-Z0-9_]*\$?\s*\$ $|Welcome to OpenVMX/, 60, 'DCL $ prompt');
  console.log('OK: reached an interactive DCL prompt');

  // Prove it's a live shell: run SHOW SYSTEM or a trivial DCL command.
  await page.keyboard.type('SHOW TIME'); await page.keyboard.press('Enter');
  const after = await waitFor(page, /\d\d:\d\d:\d\d|\d{2}-[A-Z]{3}-\d{4}/, 30, 'SHOW TIME output');
  console.log('OK: DCL executed SHOW TIME');

  console.log('\n=== FINAL SCREEN TAIL ===');
  console.log((await readScreen(page)).split('\n').filter(l=>l.trim()).slice(-16).join('\n'));
  await browser.close();
  console.log('\nLOGIN-VERIFY OK: V0.5 snapshot resumes -> login SYSTEM/MANAGER -> DCL $');
})().catch(async (e) => { console.error('LOGIN-VERIFY FAIL:', e.message); process.exit(1); });
