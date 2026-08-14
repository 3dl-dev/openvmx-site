// glamor.js — produce the social-unfurl image (og-demo.png) from the REAL demo.
//
// Cold-boots the OVMX guest in the fixed big-font amber harness
// (glamor-index.html), wakes the operator console, logs in system/MANAGER, runs
// the showcase command, and screenshots the ACTUAL #terminal element (real amber
// xterm pixels — not a mock). Then frames it into glamor-card.html with the
// version/node read off the running guest, and writes the 1200x630 card.
//
//   node glamor.js <base-url> <out.png>
//   base-url must serve a dir containing glamor-index.html + the boot assets
//   (vmlinuz, initramfs-ovmx.cpio.gz, sysdisk.qcow2.gz, out.js, the wasm, the
//   pc-bios rom pack, and assets/).
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://localhost:8100';
const OUT = path.resolve(process.argv[3] || 'og-demo.png');
const CARD = 'file://' + path.resolve(__dirname, 'glamor-card.html');
const TERM_PNG = path.resolve(path.dirname(OUT), 'og-terminal.png');
const TIMEOUT_S = +(process.env.GLAMOR_TIMEOUT_S || 320);
// Terminal geometry for the shot. Few rows + big font => legible at card sizes.
// COLS is sized so the command's widest line does not wrap.
const COLS = +(process.env.GLAMOR_COLS || 88);
const ROWS = +(process.env.GLAMOR_ROWS || 10);
const FS = +(process.env.GLAMOR_FS || 28);
const CMD = process.env.GLAMOR_CMD || 'SHOW USERS';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readScreen = (p) => p.evaluate(() => {
  const t = window.__ovmxTerm; if (!t) return '';
  const b = t.buffer.active; let s = '';
  for (let j = 0; j < b.length; j++) { const l = b.getLine(j); if (l) s += l.translateToString(true) + '\n'; }
  return s;
});
async function waitFor(p, re, secs, label) {
  for (let i = 0; i < secs * 4; i++) { const s = await readScreen(p); if (re.test(s)) return s; await sleep(250); }
  throw new Error('TIMEOUT waiting for ' + (label || re));
}
// Wait until the DCL prompt is actually ready — the last non-empty line is a
// bare "$" (translateToString trims the trailing space). Typing before this
// races the prompt and the echo lands on a bare line.
async function waitPrompt(p, secs) {
  for (let i = 0; i < secs * 4; i++) {
    const lines = (await readScreen(p)).split('\n').filter((x) => x.trim());
    if ((lines[lines.length - 1] || '').trim() === '$') return;
    await sleep(250);
  }
  throw new Error('TIMEOUT waiting for DCL prompt');
}

(async () => {
  const browser = await chromium.launch({
    headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'],
    executablePath: process.env.CHROME_BIN || undefined,
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGEERR', e.message));

  const url = `${BASE}/glamor-index.html?cols=${COLS}&rows=${ROWS}&fs=${FS}`;
  console.log('cold-booting harness:', url);
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ovmxTerm, { timeout: 30000 });

  // Cold boot: wait for the startup dialog, then wake the operator console
  // (LOGINOUT waits for a RETURN before it presents Username:), then log in.
  console.log('waiting for startup dialog…');
  await waitFor(page, /site-specific startup|%OVMX-I-EXEC|PROC_ID/, TIMEOUT_S, 'startup');
  await page.click('#terminal');
  for (let i = 0; i < 40; i++) {                        // nudge until Username: appears
    if (/Username:/.test(await readScreen(page))) break;
    await page.keyboard.press('Enter'); await sleep(1500);
  }
  await waitFor(page, /Username:/, 30, 'Username:');

  console.log('logging in system/MANAGER');
  await sleep(500); await page.keyboard.type('system'); await page.keyboard.press('Enter');
  await waitFor(page, /Password:/, 30, 'Password:');
  await sleep(400); await page.keyboard.type('MANAGER'); await page.keyboard.press('Enter');
  await waitFor(page, /Welcome/, 40, 'welcome');
  await waitPrompt(page, 40);           // let DCL finish printing "$ " before typing

  // Run the command. With few rows the login banner scrolls off and the shot
  // opens on "$ CMD" — no clear() needed (clear() leaves a stray prompt).
  console.log('running:', CMD);
  await page.keyboard.type(CMD); await page.keyboard.press('Enter');
  await sleep(2500);
  await waitPrompt(page, 30);           // wait for the command to finish + prompt return

  const screen = await readScreen(page);
  console.log('----- captured screen -----\n' + screen.replace(/\n{2,}/g, '\n') + '\n---------------------------');
  const ver = (screen.match(/OpenVMX\s+(V?\d+\.\d+(?:-\d+)?)/) || [])[1]
    || (fs.existsSync('boot/DEPLOYED_TAG') ? fs.readFileSync('boot/DEPLOYED_TAG', 'utf8').trim() : 'V0.4');
  const node = (screen.match(/on node\s+(\S+)/) || [])[1] || 'OVMX';
  console.log('version=' + ver + ' node=' + node);

  await page.locator('#terminal').screenshot({ path: TERM_PNG });
  console.log('terminal shot ->', TERM_PNG);

  // Frame into the branded 1200x630 card.
  const cardPage = await (await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 })).newPage();
  await cardPage.goto(CARD, { waitUntil: 'load' });
  const dataUri = 'data:image/png;base64,' + fs.readFileSync(TERM_PNG).toString('base64');
  await cardPage.evaluate(({ uri, ver, node }) => {
    document.getElementById('ver').textContent = ver;
    document.getElementById('node').textContent = node;
    const img = document.getElementById('shot');
    return new Promise((res) => { img.onload = res; img.src = uri; });
  }, { uri: dataUri, ver, node });
  await sleep(150);
  await cardPage.screenshot({ path: OUT });
  console.log('OG card ->', OUT);

  await browser.close();
})().catch((e) => { console.error('GLAMOR FATAL', e.message); process.exit(1); });
