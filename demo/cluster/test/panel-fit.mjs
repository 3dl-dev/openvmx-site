// panel-fit.mjs -- every console panel of the cluster demo must be an 80x24 VT screen that
// exactly fills its panel, with NO scroll bar anywhere (Baron's review of the public demo,
// finding 1: "the text panels aren't the same size as the emulated screen, so there are scroll
// bars everywhere").
//
// What it does: serves the whole site root with the repo's coi-server, loads demo/cluster/
// index.html at 1280x800, 1920x1080 and 390x844, clicks the three real boot buttons (the nodes
// themselves cannot boot offline -- their media 404s -- which is fine: the consoles are fed
// directly through the same entry points the real boot output uses: window.__nodeTerm.write for
// Node A, window.__clusterNode.injectOut for the pcjs nodes B and C), then for every node frame
// (and every frame nested inside it) walks every element and FAILS if
//   - any element shows a scroll bar (a layout gutter: offset size > client size + borders),
//   - the document of any frame scrolls (content wider/taller than the viewport, overflow not hidden),
//   - the terminal is not 80 columns x 24 rows, or
//   - the 80x24 character grid does not fill >= FILL of the panel in both axes.
//
// Run:  node demo/cluster/test/panel-fit.mjs [--shots <dir>] [--report]
// Playwright: resolved from node_modules (CI: `npm i playwright`), else $PLAYWRIGHT_JS, else
// the sibling openvmx-site checkout. --report prints measurements and never fails.

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, '../../..');
const coiServer = join(siteRoot, 'tools/webdemo/coi-server.js');
const args = process.argv.slice(2);
const REPORT = args.includes('--report');
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
const TAG = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : 'run';
const FILL = 0.97;               // the grid must cover >= 97% of the panel in each axis
const VIEWPORTS = [[1280, 800], [1920, 1080], [390, 844]];

async function loadPlaywright() {
  const tries = [() => import('playwright'), () => import(pathToFileURL(process.env.PLAYWRIGHT_JS || '/nonexistent').href),
    () => import('/home/baron/projects/openvmx-site/node_modules/playwright/index.js')];
  for (const t of tries) { try { const m = await t(); return m.chromium || m.default.chromium; } catch (e) {} }
  throw new Error('playwright not found (npm i playwright, or set PLAYWRIGHT_JS)');
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ~60 lines incl. a >100-column one, enough to push 24+ rows into scrollback.
const SAMPLE = Array.from({ length: 60 }, (_, i) => `%OVMX-I-LINE, console line ${String(i).padStart(2, '0')} ` + 'x'.repeat(i % 7 === 0 ? 90 : 20)).join('\r\n') + '\r\nUsername: ';

// Runs INSIDE a frame: every scroll bar / document scroll in it.
function scan() {
  const out = [];
  const px = (v) => parseFloat(v) || 0;
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const gx = el.offsetHeight - el.clientHeight - px(cs.borderTopWidth) - px(cs.borderBottomWidth);   // horizontal bar thickness
    const gy = el.offsetWidth - el.clientWidth - px(cs.borderLeftWidth) - px(cs.borderRightWidth);     // vertical bar thickness
    if (el.clientWidth && gy > 1 && cs.display !== 'inline') out.push(`${name(el)}: vertical scroll bar ${gy.toFixed(0)}px`);
    if (el.clientHeight && gx > 1 && cs.display !== 'inline') out.push(`${name(el)}: horizontal scroll bar ${gx.toFixed(0)}px`);
  }
  const de = document.documentElement, b = document.body;
  for (const el of [de, b]) {
    const ov = getComputedStyle(el);
    const clipped = (o) => o === 'hidden' || o === 'clip';
    if (el.scrollWidth > el.clientWidth + 1 && !(clipped(ov.overflowX) || (el === b && clipped(getComputedStyle(de).overflowX))))
      out.push(`${name(el)}: scrolls horizontally (${el.scrollWidth} > ${el.clientWidth})`);
    if (el.scrollHeight > el.clientHeight + 1 && !(clipped(ov.overflowY) || (el === b && clipped(getComputedStyle(de).overflowY))))
      out.push(`${name(el)}: scrolls vertically (${el.scrollHeight} > ${el.clientHeight})`);
  }
  return out;
}

// Node A (xterm): cols/rows + grid box.
function geomXterm() {
  const t = window.__nodeTerm;
  // the grid as the visitor sees it: the .xterm-screen box (cols*cell x rows*cell, times any CSS scale)
  const d = document.querySelector('.xterm-screen').getBoundingClientRect();   // as rendered (after any scale)
  return { kind: 'xterm', cols: t.cols, rows: t.rows, gridW: d.width, gridH: d.height, viewW: innerWidth, viewH: innerHeight, font: t.options.fontSize };
}
// pcjs <pre id=screen>: cols/rows = how many glyph cells fit the content box.
function geomPre() {
  const s = document.getElementById('screen'), cs = getComputedStyle(s);
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:' + cs.font;
  probe.textContent = 'M'.repeat(100); s.appendChild(probe);
  const cw = probe.getBoundingClientRect().width / 100; probe.remove();
  const lh = px(cs.lineHeight) || px(cs.fontSize) * 1.2;
  function px(v) { return parseFloat(v) || 0; }
  const w = s.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight), h = s.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
  const r = s.getBoundingClientRect();
  return { kind: 'pre', cols: +(w / cw).toFixed(2), rows: +(h / lh).toFixed(2), gridW: w, gridH: h, viewW: innerWidth, viewH: innerHeight, font: cs.fontSize,
    scrolledToEnd: s.scrollTop + s.clientHeight >= s.scrollHeight - 1 };
}

async function main() {
  const chromium = await loadPlaywright();
  const port = await freePort();
  const srv = spawn('node', [coiServer, siteRoot, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => console.error('[coi-server]', '' + d));
  await sleep(500);
  const base = `http://localhost:${port}`;
  const machine = `${base}/demo/cluster/pcjs/machines/dec/vax/browser/ovmx-cluster.html`;   // no ?rom= : no boot, injectOut still works
  const url = `${base}/demo/cluster/index.html?nodeB=${encodeURIComponent(machine)}&nodeC=${encodeURIComponent(machine)}&initramfs=none&sysdisk=none`;
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  // headless Chromium hides scroll bars by default; a visitor's browser does not -- show them.
  const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  const fails = [], rows = [];
  try {
    for (const [W, H] of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, hasTouch: W < 600 });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__demoReady === true, null, { timeout: 15000 });
      for (const id of ['a', 'b', 'c']) { await page.locator('#bootbtn-' + id).scrollIntoViewIfNeeded(); await page.locator('#bootbtn-' + id).click(); }
      // wait for the three node pages (+ the nested machine pages) to be there
      await page.waitForFunction(() => document.querySelectorAll('.machine-screen iframe').length === 3, null, { timeout: 15000 });
      const t0 = Date.now();
      let nodeA, pcjs = [];
      while (Date.now() - t0 < 20000) {
        const fr = page.frames();
        nodeA = fr.find((f) => /\/node\.html(\?|$)/.test(f.url()));
        pcjs = fr.filter((f) => /\/ovmx-cluster\.html(\?|$)/.test(f.url()));
        if (nodeA && pcjs.length === 2) {
          const ok = await Promise.all([nodeA.evaluate(() => !!window.__nodeTerm).catch(() => false), ...pcjs.map((f) => f.evaluate(() => !!window.__clusterNode).catch(() => false))]);
          if (ok.every(Boolean)) break;
        }
        await sleep(200);
      }
      if (!nodeA || pcjs.length !== 2) throw new Error(`${W}x${H}: node frames missing (A=${!!nodeA}, pcjs=${pcjs.length})`);
      // feed the consoles
      await nodeA.evaluate((s) => new Promise((r) => window.__nodeTerm.write(s, r)), SAMPLE);
      const bytes = Array.from(Buffer.from(SAMPLE));
      for (const f of pcjs) await f.evaluate((b) => window.__clusterNode.injectOut(b), bytes);
      await sleep(600);   // pcjs repaints on a 100 ms interval; let the fit settle
      const panels = [['A', 'screen-a', nodeA, geomXterm], ['B', 'screen-b', pcjs[0], geomPre], ['C', 'screen-c', pcjs[1], geomPre]];
      // pcjs[0]/[1] are in DOM order of creation (B then C); map by owning panel to be sure
      for (const p of panels.slice(1)) {
        const owner = await page.evaluate((id) => document.getElementById(id).querySelector('iframe').getAttribute('title'), p[1]);
        p.push(owner);
      }
      for (const [label, screenId, frame, geom] of panels) {
        const box = await page.locator('#' + screenId).boundingBox();
        const g = await frame.evaluate(geom);
        const bars = [];
        // scan the node frame, the pcjs wrapper and the nested machine frame
        const chain = label === 'A' ? [frame] : [frame.parentFrame(), frame].filter(Boolean);
        for (const fr of chain) for (const m of await fr.evaluate(scan)) bars.push(`[${fr.url().split('/').pop().split('?')[0]}] ${m}`);
        // the embedded machine must fill its wrapper page exactly (no stray wrapper content -- e.g. text
        // from a malformed HTML comment -- pushing the console out of the panel)
        if (label !== 'A') {
          const wr = await frame.parentFrame().evaluate(() => { const r = document.getElementById('machine').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, txt: document.body.innerText.replace(/\s+/g, ' ').trim() }; });
          if (Math.abs(wr.x) > 1 || Math.abs(wr.y) > 1 || Math.abs(wr.w - wr.vw) > 1 || Math.abs(wr.h - wr.vh) > 1)
            bars.push(`machine iframe is not flush with its wrapper (at ${wr.x},${wr.y} ${wr.w}x${wr.h} in ${wr.vw}x${wr.vh})`);
          if (wr.txt) bars.push(`wrapper page shows stray text: "${wr.txt.slice(0, 60)}"`);
        }
        // outer page: the panel must not make the page scroll sideways
        const outerX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (outerX > 1) bars.push(`outer page scrolls horizontally by ${outerX}px`);
        const fillW = g.gridW / g.viewW, fillH = g.gridH / g.viewH;
        const row = { viewport: `${W}x${H}`, node: label, panel: `${Math.round(box.width)}x${Math.round(box.height)}`, term: `${g.cols}x${g.rows}`, font: g.font, fill: `${(fillW * 100).toFixed(0)}%x${(fillH * 100).toFixed(0)}%`, bars };
        rows.push(row);
        const bad = [];
        if (Math.round(g.cols) !== 80 || Math.round(g.rows) !== 24 || Math.abs(g.cols - 80) > 0.5 || Math.abs(g.rows - 24) > 0.5) bad.push(`terminal is ${g.cols}x${g.rows}, not 80x24`);
        if (fillW < FILL || fillH < FILL) bad.push(`80x24 grid fills only ${(fillW * 100).toFixed(0)}% x ${(fillH * 100).toFixed(0)}% of the panel`);
        if (g.kind === 'pre' && !g.scrolledToEnd) bad.push('pcjs screen not scrolled to the latest line');
        for (const b of bars) bad.push(b);
        for (const b of bad) fails.push(`${W}x${H} node ${label}: ${b}`);
      }
      if (shotsDir) {
        await page.locator('.machines').screenshot({ path: join(shotsDir, `${TAG}-${W}x${H}.png`) });
        for (const [label, screenId] of panels) await page.locator('#' + screenId).screenshot({ path: join(shotsDir, `${TAG}-${W}x${H}-${label}.png`) });
      }
      await ctx.close();
    }
  } finally { await browser.close(); srv.kill(); }
  console.log('viewport   node panel     term   font    grid-fill   scrollbars');
  for (const r of rows) console.log(`${r.viewport.padEnd(10)} ${r.node}    ${r.panel.padEnd(9)} ${String(r.term).padEnd(7)}${String(r.font).padEnd(8)}${r.fill.padEnd(12)}${r.bars.length}${r.bars.length ? '  ' + r.bars.join(' | ') : ''}`);
  if (fails.length && !REPORT) { console.error('\nFAIL panel-fit:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log(fails.length ? `\n(report mode: ${fails.length} violations)` : '\nPASS panel-fit: every panel is 80x24, fills its panel, no scroll bars');
}
main().catch((e) => { console.error(e); process.exit(2); });
