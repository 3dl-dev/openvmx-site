// isolate-rx.mjs — rd vms-0cd2 ONE-BOOT bisection.
// Boots ONLY Node A (config-injected, group 257), logs in, baselines
// SHOW CLUSTER/LOCAL_PORTS, injects ONE synthetic well-formed 60-byte 0x6007
// frame addressed to the group-257 multicast down the REAL chain
// (window.__hub port emit -> registerNode send -> postMessage -> node.html
// pipe -> worker nic-rx -> nic.deliverToGuest), then re-reads the executive's
// own rx counter + every JS-layer counter to name the broken layer.
const { chromium } = require('playwright');
const fs = require('fs');
const PORT = process.env.PORT || 8110;
const INITRAMFS = process.env.INITRAMFS || 'initramfs-ovmx-nodeA.cpio.gz';
const SYSDISK = process.env.SYSDISK || 'sysdisk-nodeA.qcow2.gz';
const OUT = process.env.OUT || (__dirname + '/isolate-rx-result.json');
const BOOT_DEADLINE_MS = +(process.env.BOOT_DEADLINE_MS || 600000);
const LOGIN_DEADLINE_MS = +(process.env.LOGIN_DEADLINE_MS || 120000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nodeAWorker(page) {
  return page.evaluate(() => {
    const f = document.getElementById('nodeA');
    return f && f.contentWindow ? true : false;
  });
}

async function sendKeys(page, text) {
  await page.evaluate((t) => {
    const f = document.getElementById('nodeA');
    f.contentWindow.__nodeWorker.postMessage({ t: 'in', d: t });
  }, text);
}

async function consoleTail(page) {
  return page.evaluate(() => {
    const f = document.getElementById('nodeA');
    const ns = f && f.contentWindow && f.contentWindow.__nodeState;
    return ns ? ns.consoleText || '' : '';
  }).catch(() => '');
}

async function nodeState(page) {
  return page.evaluate(() => {
    const f = document.getElementById('nodeA');
    const ns = f && f.contentWindow && f.contentWindow.__nodeState;
    if (!ns) return null;
    return {
      nicTxCount: ns.nicTxCount, nicRxCount: ns.nicRxCount,
      nicRxWorkerCount: ns.nicRxWorkerCount, nicRxDeliverCalls: ns.nicRxDeliverCalls,
      nicRxDeliverOk: ns.nicRxDeliverOk, nicRxHadNic: ns.nicRxHadNic,
      acpOk: ns.acpOk, workerError: ns.workerError,
      nicDiag: ns.nicDiag ? ns.nicDiag.slice() : [],
    };
  }).catch(() => null);
}

(async () => {
  const log = [];
  const rec = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (!/progress|Downloading|Unpacking/.test(t)) rec('[c]', t.slice(0, 220));
  });
  page.on('pageerror', (e) => rec('[pageerr]', e.message));

  const url = `http://localhost:${PORT}/demo/cluster/index.html?initramfs=${encodeURIComponent(INITRAMFS)}&sysdisk=${encodeURIComponent(SYSDISK)}`;
  rec('goto', url);
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.click('#bootbtn-a');
  rec('clicked #bootbtn-a — Node A ONLY, no Node B/C');

  // ---- Phase 1: boot to Username: ----
  let t0 = Date.now();
  let sawUsername = false;
  while (Date.now() - t0 < BOOT_DEADLINE_MS) {
    const ct = await consoleTail(page);
    if (/Username:/.test(ct)) { sawUsername = true; break; }
    await sleep(2000);
  }
  const bootConsole = await consoleTail(page);
  rec('boot phase done, sawUsername=', sawUsername, 'elapsed_s=', Math.round((Date.now() - t0) / 1000));
  if (!sawUsername) {
    const result = { phase: 'boot', pass: false, reason: 'never reached Username:', console_tail: bootConsole.slice(-4000) };
    fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
    rec('ISOLATE_RESULT=' + JSON.stringify({ phase: 'boot', pass: false }));
    await browser.close();
    process.exit(2);
  }

  // ---- Phase 2: log in SYSTEM/MANAGER ----
  await sendKeys(page, 'SYSTEM\r');
  t0 = Date.now();
  let sawPassword = false;
  while (Date.now() - t0 < LOGIN_DEADLINE_MS) {
    const ct = await consoleTail(page);
    if (/Password:/.test(ct)) { sawPassword = true; break; }
    await sleep(1000);
  }
  rec('sawPassword=', sawPassword);
  await sendKeys(page, 'MANAGER\r');
  t0 = Date.now();
  let sawPrompt = false;
  while (Date.now() - t0 < LOGIN_DEADLINE_MS) {
    const ct = await consoleTail(page);
    if (/\r\n\$\s*$/.test(ct) || /\$$/.test(ct.trimEnd())) { sawPrompt = true; break; }
    await sleep(1000);
  }
  rec('sawPrompt=', sawPrompt, 'tail=', (await consoleTail(page)).slice(-300));
  await sleep(2000);

  // ---- Phase 3: baseline SHOW CLUSTER/LOCAL_PORTS ----
  async function showLocalPorts() {
    const before = (await consoleTail(page)).length;
    await sendKeys(page, 'SHOW CLUSTER/LOCAL_PORTS\r');
    const t1 = Date.now();
    let ct = '';
    while (Date.now() - t1 < 20000) {
      ct = await consoleTail(page);
      if (ct.length > before && /frames tx/.test(ct.slice(before))) break;
      await sleep(500);
    }
    return ct;
  }
  const baselineConsole = await showLocalPorts();
  rec('baseline SHOW CLUSTER/LOCAL_PORTS tail:');
  rec(baselineConsole.slice(-1200));
  const baselineState = await nodeState(page);
  rec('baseline nodeState=', JSON.stringify(baselineState));

  // ---- Phase 4: inject ONE synthetic well-formed 60-byte 0x6007 frame ----
  // dst = AB:00:04:01:01:01 (VMScluster group-257 multicast), src = fake peer MAC,
  // ethertype = 0x6007, padded to 60 bytes. Injected via window.__hub: a fake peer
  // port's emit() floods to every OTHER live port (Node A's), exactly as a real
  // peer's TX would — the REAL chain, not a shortcut into the worker/NIC directly.
  const injectResult = await page.evaluate(() => {
    try {
      const frame = new Uint8Array(60);
      const dst = [0xAB, 0x00, 0x04, 0x01, 0x01, 0x01];
      const src = [0x52, 0x54, 0x00, 0x00, 0x00, 0x0C];
      frame.set(dst, 0); frame.set(src, 6);
      frame[12] = 0x60; frame[13] = 0x07; // ethertype 0x6007
      const before = window.__hubframes.length;
      const fake = window.__hub.addPort({ name: 'FAKEPEER-INJECT', send: () => {} });
      const delivered = fake.emit(frame);
      fake.remove();
      return { ok: true, delivered, hubframesBefore: before, hubframesAfter: window.__hubframes.length };
    } catch (e) {
      return { ok: false, error: String(e && e.stack || e) };
    }
  });
  rec('inject result=', JSON.stringify(injectResult));

  // ---- Phase 5: re-poll per-layer JS counters + re-run SHOW CLUSTER/LOCAL_PORTS ----
  await sleep(3000);
  const postInjectState = await nodeState(page);
  rec('post-inject nodeState (page/worker layers)=', JSON.stringify(postInjectState));

  // ---- rd vms-0cd2 framing-parity + handler-attachment check ----
  // Compare a REAL TX frame's on-wire prefix (ground truth, what QEMU itself writes
  // and expects to read back) against our injected frame's deliver-attempt prefix,
  // and confirm SOCKFS actually attached its onmessage handler before we delivered.
  const diag = (postInjectState && postInjectState.nicDiag) || [];
  const sendRaw = diag.filter((d) => d.t === 'send-raw');
  const onmessageSet = diag.filter((d) => d.t === 'onmessage-set');
  const deliverAttempt = diag.filter((d) => d.t === 'deliver-attempt');
  const deliverResult = diag.filter((d) => d.t === 'deliver-result');
  rec('nicDiag onmessage-set events=', JSON.stringify(onmessageSet));
  rec('nicDiag sample real TX send-raw (ground truth framing)=', JSON.stringify(sendRaw.slice(0, 2)));
  rec('nicDiag our deliver-attempt (injected frame framing)=', JSON.stringify(deliverAttempt.slice(-1)));
  rec('nicDiag our deliver-result (hadHandler at delivery)=', JSON.stringify(deliverResult.slice(-1)));

  const afterConsole = await showLocalPorts();
  rec('post-inject SHOW CLUSTER/LOCAL_PORTS tail:');
  rec(afterConsole.slice(-1200));
  const finalState = await nodeState(page);
  rec('final nodeState=', JSON.stringify(finalState));

  // Parse "frames tx N (errors N), rx N (dropped: nobuf N, badclass N)" from console.
  function parseRxTx(txt) {
    const m = txt.match(/frames tx (\d+) \(errors (\d+)\), rx (\d+) \(dropped: nobuf (\d+), badclass (\d+)\)/);
    if (!m) return null;
    return { tx: +m[1], txErrors: +m[2], rx: +m[3], rxNobuf: +m[4], rxBadclass: +m[5] };
  }
  const baselineExec = parseRxTx(baselineConsole);
  const finalExec = parseRxTx(afterConsole);

  const result = {
    injectResult,
    baselineExec, finalExec,
    baselineState, postInjectState, finalState,
    bisection: {
      pageRxCount_delta: (finalState ? finalState.nicRxCount : null) - (baselineState ? baselineState.nicRxCount : null),
      workerRxCount_delta: (finalState ? finalState.nicRxWorkerCount : null) - (baselineState ? baselineState.nicRxWorkerCount : null),
      deliverCalls_delta: (finalState ? finalState.nicRxDeliverCalls : null) - (baselineState ? baselineState.nicRxDeliverCalls : null),
      deliverOk_delta: (finalState ? finalState.nicRxDeliverOk : null) - (baselineState ? baselineState.nicRxDeliverOk : null),
      execRx_delta: finalExec && baselineExec ? finalExec.rx - baselineExec.rx : null,
    },
    diagSummary: { onmessageSet, sendRawSample: sendRaw.slice(0, 3), deliverAttempt, deliverResult },
    console_tail: afterConsole.slice(-3000),
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  rec('ISOLATE_RESULT=' + JSON.stringify(result.bisection));
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error('ISOLATE_ERR', e && e.stack || e);
  fs.writeFileSync(OUT, JSON.stringify({ error: String(e) }));
  process.exit(1);
});
