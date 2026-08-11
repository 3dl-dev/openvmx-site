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
//   node capture.js <base-url> <out-qcow2>
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8099';
const OUT = process.argv[3] || './sysdisk.qcow2';
const BOOT_TIMEOUT_S = +(process.env.BOOT_TIMEOUT_S || 240);
// Universal late-kernel marker: every Linux boot frees init memory right before
// running /init. It lands ~0.2s of guest time before the first vms: line, i.e.
// seconds of wall time under wasm TCG — snapshotting here replays the whole
// executive attach + startup. Firing slightly early is harmless (the demo's
// "Resuming…" curtain hides the sub-second silent tail); firing late would clip
// the executive lines, so the OVERSHOOT guard fails the run rather than ship it.
const MARK = /Freeing unused/;
const OVERSHOOT = /vms: |%OVMX-I-EXEC/;

const readScreen = (p) => p.evaluate(() => {
  const t = window.__ovmxTerm; if (!t) return '';
  const b = t.buffer.active; let s = '';
  for (let j = 0; j < b.length; j++) { const l = b.getLine(j); if (l) s += l.translateToString(true) + '\n'; }
  return s;
});

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.CHROME_BIN || undefined });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGEERR', e.message));
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 20000 });

  // Poll fast (250ms) so the marker line is caught before it scrolls away.
  let hit = false;
  for (let i = 0; i < BOOT_TIMEOUT_S * 4; i++) {
    const s = await readScreen(page);
    if (!hit && OVERSHOOT.test(s)) { console.error('FAIL: VMS/executive output appeared before the marker fired (overshoot)'); process.exit(5); }
    if (MARK.test(s)) { console.log('handoff marker seen ~' + (i / 4) + 's'); hit = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!hit) { console.error('FAIL: kernel handoff marker not seen within ' + BOOT_TIMEOUT_S + 's'); process.exit(2); }

  // Drive the monitor promptly (short waits keep us inside the pre-VMS window).
  await page.click('#terminal');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await new Promise((r) => setTimeout(r, 300));
  await page.keyboard.press('KeyC');
  await new Promise((r) => setTimeout(r, 700));
  if (!/\(qemu\)/.test(await readScreen(page))) { console.error('FAIL: monitor not reached'); process.exit(3); }
  await page.keyboard.type('savevm ovmx'); await page.keyboard.press('Enter');

  let last = -1, stable = 0, size = 0;
  for (let i = 0; i < 90; i++) {
    size = await page.evaluate(() => { try { return window.__ovmxMod.FS.stat('/pack-disk/sysdisk.qcow2').size; } catch (e) { return -1; } });
    if (size === last) { if (++stable >= 3) break; } else { stable = 0; last = size; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const err = (await readScreen(page)).split('savevm').pop() || '';
  if (/Error|failed|No space/i.test(err)) { console.error('FAIL: savevm error:', err.slice(0, 160)); process.exit(4); }
  console.log('savevm complete, qcow2 = ' + size + ' bytes');

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
