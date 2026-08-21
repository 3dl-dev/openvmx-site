// capture.js — boot the OVMX guest under our qemu-wasm (single-thread capture
// harness) in headless Chromium and savevm the 'ovmx' snapshot at the
// kernel->/init HANDOFF, so each release's demo RESUMES INTO THE REAL STARTUP
// DIALOG (executive attach, DKA0: mount, STDRV, image installs, banner) and
// then the Username: prompt — instead of jumping straight to Username.
//
// WHY THE HANDOFF, AND WHY IN-WASM:
//   The slow part of a cold boot is the Linux kernel coming up (~70-90s under
//   wasm TCG); the OVMX startup dialog after it is <1s of guest time. Snapshot-
//   ting at the handoff freezes the slow part and replays the interesting part.
//   The capture harness boots VERBOSE (console=ttyS0, no `quiet`) so (a) the
//   kernel marker below is visible for detection and (b) the snapshot bakes a
//   verbose console-loglevel, so the vms.ko executive-attach lines replay too.
//   Capturing in-wasm (same binary that later loads the snapshot) guarantees
//   savevm/loadvm compatibility, and the ~70-90s wasm boot makes the window
//   between the marker and the first VMS line SECONDS wide — ample time to drive
//   the monitor and savevm without racing past it. (A native capture would
//   overshoot: a fast host boots in ~3s, far too quick to react to a mid-boot
//   marker.)
//
// WHY THE RETRY LOOP (V0.5):
//   The V0.5 image is larger and the boot heavier than V0.4-x. On the CI runner
//   we observed a one-off where `savevm ovmx` came back with a fresh kernel
//   boot line ("[    0.000000] ...") instead of a clean prompt — the guest had
//   reset under the monitor rather than snapshotting. It is not a provisioning
//   reboot (V0.5 boots straight through to Username with no reboot — verified)
//   nor a memory ceiling (savevm succeeds even after a deliberate 90s overshoot
//   deep into startup; the snapshot barely grows), but a transient qemu-wasm
//   savevm hiccup that did not reproduce locally across repeated runs. So rather
//   than ship a bad snapshot on a transient, each capture ATTEMPT is idempotent
//   (a fresh page load re-boots into a clean in-memory disk) and we RETRY on any
//   savevm failure — an explicit guest-reset detector included — up to
//   CAPTURE_ATTEMPTS times. The downstream verify.js gate is still the backstop:
//   a snapshot that resets or clips never reaches the site.
//
//   node capture.js <base-url> <out-qcow2>
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8099';
const OUT = process.argv[3] || './sysdisk.qcow2';
const BOOT_TIMEOUT_S = +(process.env.BOOT_TIMEOUT_S || 300);
const ATTEMPTS = +(process.env.CAPTURE_ATTEMPTS || 3);
// Universal late-kernel marker: every Linux boot frees init memory right before
// running /init. It lands ~0.2s of guest time before the first vms: line, i.e.
// seconds of wall time under wasm TCG — snapshotting here replays the whole
// executive attach + startup. Firing slightly early is harmless (the demo's
// "Resuming…" curtain hides the sub-second silent tail); firing late would clip
// the executive lines, so the OVERSHOOT guard fails the run rather than ship it.
const MARK = /Freeing unused/;
const OVERSHOOT = /vms: |%OVMX-I-EXEC/;
// A fresh kernel boot line appearing UNDER the monitor after `savevm` means the
// guest reset instead of snapshotting — treat it as a failed attempt, not a
// snapshot. (Seen once on CI as "[    0.000000] B...".)
const GUEST_RESET = /\[\s*0\.000000\]/;
const SAVEVM_ERR = /Error|No space left|Unknown command|not found|Device/i;

const readScreen = (p) => p.evaluate(() => {
  const t = window.__ovmxTerm; if (!t) return '';
  const b = t.buffer.active; let s = '';
  for (let j = 0; j < b.length; j++) { const l = b.getLine(j); if (l) s += l.translateToString(true) + '\n'; }
  return s;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One capture attempt against a freshly (re)loaded page. Returns
// { ok:true, size } on a clean savevm, or { ok:false, reason } on any failure
// that a fresh re-boot could clear.
async function attempt(page, n) {
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 20000 });

  // Poll fast (250ms) so the marker line is caught before it scrolls away.
  let hit = false;
  for (let i = 0; i < BOOT_TIMEOUT_S * 4; i++) {
    const s = await readScreen(page);
    if (!hit && OVERSHOOT.test(s)) return { ok: false, reason: 'overshoot (VMS output before the marker fired)' };
    if (MARK.test(s)) { console.log('  handoff marker seen ~' + (i / 4) + 's'); hit = true; break; }
    await sleep(250);
  }
  if (!hit) return { ok: false, reason: 'kernel handoff marker not seen within ' + BOOT_TIMEOUT_S + 's' };

  // Drive the monitor promptly. Enter it (Ctrl-A c) and POLL for the (qemu)
  // prompt rather than sleeping a fixed time — that keeps the marker->savevm
  // latency minimal (less guest advance = deterministic handoff freeze) and
  // still confirms the monitor is really up before we type savevm.
  await page.click('#terminal');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await sleep(200);
  await page.keyboard.press('KeyC');
  let inMon = false;
  for (let i = 0; i < 24; i++) { // up to ~6s
    if (/\(qemu\)/.test(await readScreen(page))) { inMon = true; break; }
    await sleep(250);
  }
  if (!inMon) return { ok: false, reason: 'monitor (qemu) prompt not reached' };

  await page.keyboard.type('savevm ovmx'); await page.keyboard.press('Enter');

  // savevm is synchronous in HMP: it stops the vcpus, writes the snapshot, and
  // the (qemu) prompt returns only when done. Wait for that prompt AFTER our
  // command, and inspect ONLY the text between the command and that prompt —
  // NOT the whole screen. (Once savevm resumes the guest it keeps booting, and
  // its VERBOSE output leaks onto the monitor screen; scanning the whole buffer
  // false-positives on it.)
  for (let i = 0; i < 120; i++) {
    const scr = await readScreen(page);
    const afterCmd = scr.split('savevm ovmx').pop() || '';
    // A guest reset can appear before the prompt returns (or the prompt may
    // never return because the machine is rebooting) — catch it either way.
    if (GUEST_RESET.test(afterCmd)) return { ok: false, reason: 'guest reset under the monitor: ' + afterCmd.trim().slice(0, 80) };
    if (/\(qemu\)/.test(afterCmd)) {
      const resp = afterCmd.split(/\(qemu\)/)[0] || '';            // savevm's own output only
      if (SAVEVM_ERR.test(resp)) return { ok: false, reason: 'savevm error: ' + resp.trim().slice(0, 120) };
      let size = -1;
      try { size = await page.evaluate(() => { try { return window.__ovmxMod.FS.stat('/pack-disk/sysdisk.qcow2').size; } catch (e) { return -1; } }); } catch (e) {}
      return { ok: true, size };
    }
    await sleep(1000);
  }
  return { ok: false, reason: 'savevm did not return to the monitor prompt in 120s' };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.CHROME_BIN || undefined });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGEERR', e.message));

  let res = null;
  for (let n = 1; n <= ATTEMPTS; n++) {
    console.log('capture attempt ' + n + '/' + ATTEMPTS);
    res = await attempt(page, n);
    if (res.ok) { console.log('savevm complete, qcow2 = ' + res.size + ' bytes'); break; }
    console.error('  attempt ' + n + ' failed: ' + res.reason);
    if (n < ATTEMPTS) await sleep(1000); // fresh page.goto next iteration re-boots into a clean disk
  }
  if (!res || !res.ok) { console.error('FAIL: no clean savevm after ' + ATTEMPTS + ' attempts'); process.exit(4); }

  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.evaluate(() => {
      const d = window.__ovmxMod.FS.readFile('/pack-disk/sysdisk.qcow2');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([d])); a.download = 'sysdisk.qcow2';
      document.body.appendChild(a); a.click();
    }),
  ]);
  await dl.saveAs(OUT);
  console.log('SAVED ' + OUT);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
