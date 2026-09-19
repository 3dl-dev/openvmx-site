// e2e-boot.js — the Node-A cluster e2e GATE, host-portable.
// Boots the config-injected OVMX/x86 node headless (its virtio NIC bridged to the
// in-page L2 hub) and PASSES iff a real guest-emitted 0x6007 SCA frame reaches the
// hub. Never accepts mere netdev link-up. Doubles as the demo's per-release
// reproducibility gate. Meant to run on a >=48GB host (the wasm cold boot OOMs a
// small host); see README.md.
//
// Env: PORT, INITRAMFS (cluster_authorize image), SYSDISK (config-injected ODS-2
// disk carrying VAXCLUSTER=2), MAC, DEADLINE_MS. Writes e2e-result.json.
//
// CN=2 LANDMARK NOTE (2026-09-19, rd vms-735): when NODE_C is set, this script also
// captures Node C's (real VMS) own console transcript for the run as diagnostic
// evidence (nodeCConsoleTail in the result JSON) -- it does NOT gate `pass` on
// parsing that transcript for a membership line, because no positive ground truth
// for VMS 5.5's cluster-join OPCOM broadcast text has been captured yet (measured,
// not assumed). `pass` stays exactly the existing sca+acpOk bar. See
// docs/design/cluster-web-demo.md and the vms-735 lane notes for the frame-matching
// fix this depends on (page.frames() must exclude the PARENT frame -- its own URL
// contains "ovmx-cluster.html" as a substring via the encoded ?nodeC= query param,
// so a naive .includes() match grabs the wrong frame).
const { chromium } = require('playwright');
const fs = require('fs');
const PORT = process.env.PORT || 8110;
const INITRAMFS = process.env.INITRAMFS || 'initramfs-ovmx-nodeA.cpio.gz';
const SYSDISK = process.env.SYSDISK || '';                 // '' -> shipped stock (will NOT cluster)
const MAC = process.env.MAC || '52:54:00:00:00:0A';
const NODE_B = process.env.NODE_B || '';   // ovmx-cluster.html URL for Node B (OVMX/VAX); '' = not in the demo
const NODE_C = process.env.NODE_C || '';   // ovmx-cluster.html URL for Node C (real VMS); '' = not in the demo
const DEADLINE_MS = +(process.env.DEADLINE_MS || 600000);
const OUT = (process.env.OUT_DIR || __dirname) + '/e2e-result.json';

// Find a nested pcjs machine frame by MAC suffix (e.g. '0C' for Node C), never the
// parent page (whose own URL embeds the child's URL as an encoded query value and
// would otherwise substring-match .includes('ovmx-cluster.html') itself).
function pcjsFrame(page, macSuffix) {
  return page.frames().find((f) => f !== page.mainFrame() &&
    f.url().split('?')[0].endsWith('/ovmx-cluster.html') && f.url().includes(macSuffix));
}
async function pcjsConsoleText(page, macSuffix) {
  const f = pcjsFrame(page, macSuffix);
  if (!f) return null;
  return f.evaluate(() => { const e = document.getElementById('screen'); return e ? e.textContent : null; }).catch(() => null);
}

function url() {
  let u = `http://localhost:${PORT}/index.html?mac=${encodeURIComponent(MAC)}&initramfs=${encodeURIComponent(INITRAMFS)}`;
  if (SYSDISK) u += `&sysdisk=${encodeURIComponent(SYSDISK)}`;
  if (NODE_B) u += `&nodeB=${encodeURIComponent(NODE_B)}`;
  if (NODE_C) u += `&nodeC=${encodeURIComponent(NODE_C)}`;
  return u;
}
// CN=N gate — SUFFICIENT, not just necessary. PASS iff EACH roster node shows BOTH:
//   (a) a real guest-emitted 0x6007 at the hub (the cluster is real), AND
//   (b) acpOk = the real ODS-2 ACP mount (the PRODUCT is real, not a host-mode /vms facade).
// Never a scripted count. (Node-A-only demo: roster=[OVMXA] → the Node-A gate, product-authentic.)
const snap = () => {
  const hf = window.__hubframes || [];
  const roster = window.__roster || [];
  const scaByPort = {};
  for (const f of hf) if (f.ethertype === 0x6007) scaByPort[f.port] = (scaByPort[f.port] || 0) + 1;
  const nsByName = (window.__nodeStateByName && window.__nodeStateByName()) || {};
  const acpByPort = {}; for (const n of roster) acpByPort[n] = !!(nsByName[n] && nsByName[n].acpOk);
  let ns = null; try { ns = document.getElementById('nodeA')?.contentWindow?.__nodeState || null; } catch (e) {}
  return { total: hf.length, sca: hf.filter(f => f.ethertype === 0x6007).length,
    roster, scaByPort, acpByPort,
    clustered: roster.length > 0 && roster.every(n => (scaByPort[n] || 0) > 0 && acpByPort[n]),
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
  // Every node is now click-to-boot (2026-09-19, matching index.html's cover machines —
  // three heavy emulators must never all auto-boot at once). Click Node A always; Node B/C
  // only when their env URL is given (their boot buttons exist regardless, but the gate only
  // drives the nodes this run actually wants in the roster).
  await page.click('#bootbtn-a').catch((e) => console.log('[warn] could not click #bootbtn-a:', e.message));
  if (NODE_B) await page.click('#bootbtn-b').catch((e) => console.log('[warn] could not click #bootbtn-b:', e.message));
  if (NODE_C) await page.click('#bootbtn-c').catch((e) => console.log('[warn] could not click #bootbtn-c:', e.message));
  const t0 = Date.now(); let pass = false, lastLen = 0, lastNodeCLen = 0;
  while (Date.now() - t0 < DEADLINE_MS) {
    const s = await page.evaluate(snap).catch(() => ({ total: 0, sca: 0, types: [], nicTx: null, console: '' }));
    const el = Math.round((Date.now() - t0) / 1000);
    console.log(`t=${el}s sca_byPort=${JSON.stringify(s.scaByPort)} acp_byPort=${JSON.stringify(s.acpByPort)} roster=${JSON.stringify(s.roster)} nicTx=${s.nicTx} werr=${s.werr}`);
    if (s.console && s.console.length !== lastLen) { lastLen = s.console.length;
      const tail = s.console.replace(/\r/g, '').split('\n').filter(Boolean).slice(-3).join(' | ');
      if (tail) console.log('  guest: ' + tail.slice(-360)); }
    if (NODE_C) {
      const ct = await pcjsConsoleText(page, '0C');
      if (ct != null && ct.length !== lastNodeCLen) { lastNodeCLen = ct.length;
        const tail = ct.replace(/\r/g, '').split('\n').filter(Boolean).slice(-3).join(' | ');
        if (tail) console.log('  VAXC: ' + tail.slice(-360));
      }
    }
    if (s.clustered) { pass = true; console.log(`E2E PASS: real cluster ∧ real product — a real 0x6007 AND the ODS-2 ACP mount from EACH of ${s.roster.length} node(s) [${s.roster}] → CN=${s.roster.length}`); break; }
    await new Promise(r => setTimeout(r, 6000));
  }
  const final = await page.evaluate(() => {
    const hf = window.__hubframes || []; const roster = window.__roster || []; let ns = null;
    const scaByPort = {};
    for (const f of hf) if (f.ethertype === 0x6007) scaByPort[f.port] = (scaByPort[f.port] || 0) + 1;
    const nsByName = (window.__nodeStateByName && window.__nodeStateByName()) || {};
    const acpByPort = {}; for (const n of roster) acpByPort[n] = !!(nsByName[n] && nsByName[n].acpOk);
    try { ns = document.getElementById('nodeA')?.contentWindow?.__nodeState || null; } catch (e) {}
    return { total: hf.length, sca: hf.filter(f => f.ethertype === 0x6007).length,
      roster, scaByPort, acpByPort,
      clustered: roster.length > 0 && roster.every(n => (scaByPort[n] || 0) > 0 && acpByPort[n]),
      types: [...new Set(hf.map(f => '0x' + (f.ethertype >>> 0).toString(16)))],
      nicTx: ns ? ns.nicTxCount : null, console_tail: ns ? (ns.consoleText || '').slice(-6000) : '' };
  }).catch(() => ({}));
  // Node C's own console transcript, captured for the human record even though `pass`
  // does not parse it (see the CN=2 LANDMARK NOTE above) -- diagnostic, not a gate input.
  const nodeCConsoleTail = NODE_C ? ((await pcjsConsoleText(page, '0C').catch(() => null)) || '').slice(-6000) : '';
  const result = { pass, cn: (final.roster || []).length, clustered: !!final.clustered,
    roster: final.roster || [], scaByPort: final.scaByPort || {}, acpByPort: final.acpByPort || {},
    sca: final.sca || 0, total: final.total || 0,
    nicTx: final.nicTx, types: final.types || [], sysdisk: SYSDISK, initramfs: INITRAMFS,
    elapsed_s: Math.round((Date.now() - t0) / 1000), console_tail: final.console_tail || '',
    nodeCConsoleTail };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log('E2E_RESULT=' + JSON.stringify({ pass: result.pass, cn: result.cn, clustered: result.clustered, scaByPort: result.scaByPort, acpByPort: result.acpByPort }));
  await browser.close();
  process.exit(pass ? 0 : 2);
})().catch(e => { console.error('E2E_ERR', e && e.stack || e); fs.writeFileSync(OUT, JSON.stringify({ error: String(e) })); process.exit(1); });
