// headless-load.mjs — WIRING smoke test for the cluster-demo skeleton.
//
// Serves the WHOLE openvmx-site repo root with the repo's coi-server (COOP/COEP so
// SharedArrayBuffer works) and loads demo/cluster/index.html in headless Chromium — not
// demo/cluster/ alone, because the page links the site's shared /assets/site.css (the
// same chrome/design-system stylesheet index.html uses); serving demo/cluster/ in
// isolation would 404 that request and this test treats any requestfailed as fatal
// (see below), so the root must contain both demo/cluster/ and assets/.
// Asserts ONLY that the wiring loads clean:
//   - the parent page + its ES modules loaded (window.__demoReady, window.__hubframes[])
//   - the L2 switch has the Node-A port attached (hub.size === 1)
//   - the node iframe loaded, spawned its worker, and built the NIC pipe (__nodeState)
//   - no module-load / page errors
// It does NOT wait for a full OVMX boot (~90s) and does NOT assert a HELLO — the live
// e2e boot + 0x6007 proof is a separate step. Playwright is required from the sibling
// openvmx-site checkout (this worktree has no node_modules).
//
// Run:  node test/headless-load.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';

const PW = '/home/baron/projects/openvmx-site/node_modules/playwright/index.js';
const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, '../../..');           // openvmx-site repo root (demo/cluster + assets/)
const coiServer = join(here, '../../../tools/webdemo/coi-server.js');

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pw = await import(PW);
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  const port = await freePort();

  // start coi-server rooted at the whole site (demo/cluster/ + assets/)
  const srv = spawn('node', [coiServer, siteRoot, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => console.error('[coi-server]', '' + d));
  await sleep(400);

  const errors = [];   // fatal-ish console errors + page errors
  const notes = [];    // other console output (kept for the report)
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.type();
    const txt = m.text();
    if (t === 'error') errors.push(txt);
    else notes.push(`[${t}] ${txt}`);
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message || e)));
  page.on('requestfailed', (r) => {
    // a 404/failed subresource is a real wiring problem — record it
    const f = r.failure();
    errors.push('requestfailed: ' + r.url() + ' — ' + (f && f.errorText || 'unknown'));
  });

  const url = `http://localhost:${port}/demo/cluster/index.html`;
  let loadErr = null;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    // Poll for the wiring signals (NOT a boot). The node iframe must load, spawn its
    // worker and build the pipe; the parent must attach the port.
    const deadline = Date.now() + 20000;
    let snap = null;
    while (Date.now() < deadline) {
      snap = await page.evaluate(() => {
        const f = document.getElementById('nodeA');
        const ns = f && f.contentWindow && f.contentWindow.__nodeState || null;
        return {
          demoReady: window.__demoReady === true,
          hubframesIsArray: Array.isArray(window.__hubframes),
          hubSize: window.__hub ? window.__hub.size : -1,
          nodeState: ns ? JSON.parse(JSON.stringify(ns)) : null,
        };
      });
      if (snap.demoReady && snap.hubframesIsArray && snap.hubSize === 1 &&
          snap.nodeState && snap.nodeState.workerSpawned && snap.nodeState.pipeReady) break;
      await sleep(250);
    }

    // ---- assertions ----
    const fail = [];
    if (!snap.demoReady) fail.push('parent index.html module chain did not run (window.__demoReady)');
    if (!snap.hubframesIsArray) fail.push('window.__hubframes is not an array (harness tap missing)');
    if (snap.hubSize !== 1) fail.push(`hub port count = ${snap.hubSize}, expected 1 (attachSwitch)`);
    if (!snap.nodeState) fail.push('node iframe __nodeState absent (node.html module did not run)');
    else {
      if (!snap.nodeState.workerSpawned) fail.push('node worker did not spawn');
      if (!snap.nodeState.pipeReady) fail.push('connectNicPipe (node L2 pipe) did not initialize');
      if (snap.nodeState.workerError) fail.push('node worker error: ' + snap.nodeState.workerError);
    }
    // module-load failures are always fatal
    const moduleErrs = errors.filter((e) =>
      /Failed to (load|fetch).*module|Unexpected token 'export'|Cannot use import|SyntaxError|MIME type/.test(e));
    if (moduleErrs.length) fail.push('module-load errors: ' + JSON.stringify(moduleErrs));

    console.log('\n=== headless-load snapshot ===');
    console.log(JSON.stringify(snap, null, 2));
    console.log('console errors (' + errors.length + '):');
    for (const e of errors) console.log('  ! ' + e);
    if (notes.length) { console.log('other console (' + notes.length + ', first 10):'); for (const n of notes.slice(0, 10)) console.log('  · ' + n); }

    if (fail.length || errors.length) {
      loadErr = fail.length ? fail : ['console/page errors present (see above)'];
    }
  } catch (e) {
    loadErr = ['navigation/eval threw: ' + (e && e.message || e)];
  } finally {
    await browser.close().catch(() => {});
    srv.kill('SIGKILL');
  }

  if (loadErr) {
    console.error('\nHEADLESS-LOAD: FAIL\n - ' + loadErr.join('\n - '));
    process.exit(1);
  }
  console.log('\nHEADLESS-LOAD: PASS — wiring loaded clean (parent switch + node worker + NIC pipe), no boot awaited.');
}

main().catch((e) => { console.error(e); process.exit(1); });
