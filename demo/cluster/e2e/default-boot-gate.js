// default-boot-gate.js — the PRODUCTION-DEFAULT Node A boot gate, host-portable.
//
// Unlike e2e-boot.js (which drives the config-injected cluster-identity images via
// ?initramfs=/?sysdisk= overrides), this boots demo/cluster/index.html exactly as a
// live visitor does: click #bootbtn-a, NO query overrides, so node.html/node-worker.js
// falls back to boot/{vmlinuz,initramfs-ovmx.cpio.gz,sysdisk.qcow2.gz} -- whatever the
// site's boot/ directory actually ships today. This is the same asset set the homepage
// single-node PoC boots too.
//
// PASSES iff the guest's own serial console prints "Username:" -- the real OpenVMS
// login banner, not a KVM-only proxy. This is the ACTUAL delivery path (qemu-wasm,
// -accel tcg): a KVM boot proof is NOT equivalent evidence for this gate (vms-e287 --
// V0.7's boot/ assets passed a KVM proof on k3s-worker yet hung in this exact browser
// path after LOGINOUT process creation, never reaching Username:).
//
// Run (host has node + playwright + chromium; COOP/COEP via coi-server.js):
//   node demo/cluster/e2e/coi-server.js <serve-root> <port> &
//   PORT=<port> node demo/cluster/e2e/default-boot-gate.js
// Writes default-boot-result.json to OUT_DIR (default: this script's directory).
// Env: PORT (default 8123), DEADLINE_MS (default 900000 = 15 min -- a cold TCG boot
// of a ~90MB disk image can take several minutes), OUT_DIR.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8123;
const DEADLINE_MS = +(process.env.DEADLINE_MS || 900000);
const OUT_DIR = process.env.OUT_DIR || __dirname;
const URL = `http://localhost:${PORT}/demo/cluster/index.html`;

const snap = () => {
  let ns = null;
  try { ns = document.getElementById('nodeA')?.contentWindow?.__nodeState || null; } catch (e) {}
  return ns ? {
    workerSpawned: ns.workerSpawned, pipeReady: ns.pipeReady, firstOut: ns.firstOut,
    workerError: ns.workerError, acpOk: ns.acpOk, halt: ns.halt,
    console: (ns.consoleText || '').slice(-4000),
  } : { noState: true };
};

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on('pageerror', (e) => console.log('[pageerr]', e.message));
  console.log('goto', URL);
  await page.goto(URL, { waitUntil: 'load' });
  await page.click('#bootbtn-a');
  console.log('clicked #bootbtn-a, polling for Username: ...');

  const t0 = Date.now();
  let lastLen = -1, lastShot = 0, acpOkAt = null, mountLineAt = null, pass = false;
  while (Date.now() - t0 < DEADLINE_MS) {
    const s = await page.evaluate(snap).catch((e) => ({ evalError: String(e) }));
    const el = Math.round((Date.now() - t0) / 1000);
    if (s.console && s.console.length !== lastLen) {
      lastLen = s.console.length;
      const tail = s.console.replace(/\r/g, '').split('\n').filter(Boolean).slice(-4).join(' | ');
      console.log(`t=${el}s workerErr=${s.workerError} acpOk=${s.acpOk} halt=${s.halt} :: ${tail.slice(-400)}`);
      if (!mountLineAt && /mounting system disk/.test(s.console)) mountLineAt = el;
      if (!acpOkAt && s.acpOk) acpOkAt = el;
    }
    if (el - lastShot >= 30) { lastShot = el; await page.screenshot({ path: path.join(OUT_DIR, `shot-t${el}s.png`) }).catch(() => {}); }
    if (s.console && /Username:/.test(s.console)) {
      pass = true;
      console.log(`GATE PASS: reached Username: at t=${el}s`);
      await page.screenshot({ path: path.join(OUT_DIR, 'shot-username.png') }).catch(() => {});
      break;
    }
    if (s.workerError || s.halt) { console.log('HALT/ERROR observed, stopping poll'); break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  const final = await page.evaluate(snap).catch(() => ({}));
  if (!pass) await page.screenshot({ path: path.join(OUT_DIR, 'shot-final-timeout.png') }).catch(() => {});
  const result = {
    pass, mountLineAt, acpOkAt, elapsed_s: Math.round((Date.now() - t0) / 1000),
    console_tail: final.console || '',
  };
  fs.writeFileSync(path.join(OUT_DIR, 'default-boot-result.json'), JSON.stringify(result, null, 1));
  console.log('DEFAULT_BOOT_RESULT=' + JSON.stringify({ pass, mountLineAt, acpOkAt, elapsed_s: result.elapsed_s }));
  await browser.close();
  process.exit(pass ? 0 : 2);
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
