// e2e-boot.js — the Node-A cluster e2e GATE, host-portable.
// Boots the config-injected OVMX/x86 node headless (its virtio NIC bridged to the
// in-page L2 hub) and PASSES iff a real guest-emitted 0x6007 SCA frame reaches the
// hub. Never accepts mere netdev link-up. Doubles as the demo's per-release
// reproducibility gate. Meant to run on a >=48GB host (the wasm cold boot OOMs a
// small host); see README.md.
//
// Env: PORT, INITRAMFS (cluster_authorize image), SYSDISK (config-injected ODS-2
// disk carrying VAXCLUSTER=2), MAC, DEADLINE_MS. Writes e2e-result.json.
const { chromium } = require('playwright');
const fs = require('fs');
const PORT = process.env.PORT || 8110;
const INITRAMFS = process.env.INITRAMFS || 'initramfs-ovmx-nodeA.cpio.gz';
const SYSDISK = process.env.SYSDISK || '';                 // '' -> shipped stock (will NOT cluster)
const MAC = process.env.MAC || '52:54:00:00:00:0A';
const DEADLINE_MS = +(process.env.DEADLINE_MS || 600000);
const OUT = (process.env.OUT_DIR || __dirname) + '/e2e-result.json';

function url() {
  let u = `http://localhost:${PORT}/index.html?mac=${encodeURIComponent(MAC)}&initramfs=${encodeURIComponent(INITRAMFS)}`;
  if (SYSDISK) u += `&sysdisk=${encodeURIComponent(SYSDISK)}`;
  return u;
}
const snap = () => {
  const hf = window.__hubframes || [];
  let ns = null; try { ns = document.getElementById('nodeA')?.contentWindow?.__nodeState || null; } catch (e) {}
  return { total: hf.length, sca: hf.filter(f => f.ethertype === 0x6007).length,
    types: [...new Set(hf.map(f => '0x' + (f.ethertype >>> 0).toString(16)))],
    nicTx: ns ? ns.nicTxCount : null, werr: ns ? ns.workerError : null,
    console: ns && ns.consoleText ? ns.consoleText.slice(-1400) : '' };
};

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('[pageerr]', e.message));
  console.log('e2e goto', url());
  await page.goto(url(), { waitUntil: 'load' });
  const t0 = Date.now(); let pass = false, lastLen = 0;
  while (Date.now() - t0 < DEADLINE_MS) {
    const s = await page.evaluate(snap).catch(() => ({ total: 0, sca: 0, types: [], nicTx: null, console: '' }));
    const el = Math.round((Date.now() - t0) / 1000);
    console.log(`t=${el}s total=${s.total} sca=${s.sca} types=${s.types} nicTx=${s.nicTx} werr=${s.werr}`);
    if (s.console && s.console.length !== lastLen) { lastLen = s.console.length;
      const tail = s.console.replace(/\r/g, '').split('\n').filter(Boolean).slice(-3).join(' | ');
      if (tail) console.log('  guest: ' + tail.slice(-360)); }
    if (s.sca > 0) { pass = true; console.log('E2E PASS: real 0x6007 SCA frame reached the hub'); break; }
    await new Promise(r => setTimeout(r, 6000));
  }
  const final = await page.evaluate(() => {
    const hf = window.__hubframes || []; let ns = null;
    try { ns = document.getElementById('nodeA')?.contentWindow?.__nodeState || null; } catch (e) {}
    return { total: hf.length, sca: hf.filter(f => f.ethertype === 0x6007).length,
      types: [...new Set(hf.map(f => '0x' + (f.ethertype >>> 0).toString(16)))],
      nicTx: ns ? ns.nicTxCount : null, console_tail: ns ? (ns.consoleText || '').slice(-6000) : '' };
  }).catch(() => ({}));
  const result = { pass, sca: final.sca || 0, total: final.total || 0, nicTx: final.nicTx,
    types: final.types || [], sysdisk: SYSDISK, initramfs: INITRAMFS, elapsed_s: Math.round((Date.now() - t0) / 1000),
    console_tail: final.console_tail || '' };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log('E2E_RESULT=' + JSON.stringify({ pass: result.pass, sca: result.sca, nicTx: result.nicTx }));
  await browser.close();
  process.exit(pass ? 0 : 2);
})().catch(e => { console.error('E2E_ERR', e && e.stack || e); fs.writeFileSync(OUT, JSON.stringify({ error: String(e) })); process.exit(1); });
