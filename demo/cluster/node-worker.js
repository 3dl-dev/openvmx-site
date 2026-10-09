// node-worker.js — the classic Web Worker for ONE OVMX/x86 cluster-demo node.
// Derived from ../../boot/qemu-worker.js (the single-node boot worker). The whole
// qemu-wasm module runs in THIS worker (see boot/qemu-worker.js header for why).
//
// Differences from the single-node worker:
//   (a) importScripts('lib/nic-classic.js') FIRST → self.OVMXNic (the tested NIC core).
//   (b) A fake-WebSocket NIC shim is installed in THIS scope BEFORE importScripts('out.js').
//       QEMU's SOCKFS constructs `new WebSocket` here (empirically proven, vms-b16), so the
//       shim intercepts the guest's socket-netdev stream: guest TX frames → onNicTx →
//       postMessage{nic-tx}; inbound postMessage{nic-rx} → nic.deliverToGuest → guest RX.
//   (c) ARG FLIP: `-nic none` → `-netdev socket,connect=127.0.0.1:8888` + a virtio-net-pci
//       device (per-node MAC), and Module.websocket.url routes SOCKFS through the shim.
//   (d) MAC + initramfs are PER-NODE parameters, delivered by the page as a {t:'cfg'} message
//       (a worker global cannot be set before the worker script runs, so cfg gates the boot).
//
// Boot assets (out.js / wasm / worker.js / load-rom / vmlinuz / initramfs / disk) live in
// ../../boot/, reached here through the demo/cluster/boot symlink, so a relative 'boot/…'
// URL resolves under coi-server regardless of whether its root is demo/cluster or the site root.

importScripts('lib/nic-classic.js');            // -> self.OVMXNic { enframe, Deframer, installQemuNicWebSocket }
importScripts('boot/assets/xterm-pty.js');      // -> self.openpty
const { master, slave } = openpty();
let inputHandler = null, resizeHandler = null;
const page = {                                   // stands in for the page Terminal (pty bridge)
  write: (data, cb) => { self.postMessage({ t: 'out', d: data }); if (typeof cb === 'function') cb(); },
  onData: (h) => { inputHandler = h; return { dispose() {} }; },
  onBinary: () => ({ dispose() {} }),
  onResize: (h) => { resizeHandler = h; return { dispose() {} }; },
};
master.activate(page);

// Cache-busted payload download with real byte progress (reported to the page).
const ASSET_VER = 'cw1';  // bump when the qemu-wasm binary changes
const BOOT_VER  = 'v0.7-7'; // bump when boot/vmlinuz or the per-node images change
const PAYLOAD_VER = 'V0.7-7';
function xhrGet(url, i, loaded, total, report) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('GET', url + '?v=' + PAYLOAD_VER); x.responseType = 'arraybuffer';
    x.onprogress = (e) => { loaded[i] = e.loaded; if (e.lengthComputable) total[i] = e.total; report(); };
    x.onload = () => {
      if (x.status && x.status >= 400) return rej(new Error(url + ' ' + x.status));
      const n = x.response.byteLength; loaded[i] = n; if (n > total[i]) total[i] = n; report();
      res(new Uint8Array(x.response));
    };
    x.onerror = () => rej(new Error('net ' + url)); x.send();
  });
}
async function inflate(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

let nic = null;      // the installed NIC shim handle (deliverToGuest / connected / uninstall)
let booted = false;

// WORKER EVENT-LOOP HEARTBEAT (rd vms-4ff). When Node A stops, the page keeps
// its console and nothing else, and "the console ends at %OVMX-I-MOUNTED" does
// not say whether this worker is still running. Two live V0.7-7 runs failed
// exactly that way and could not be root-caused from what was kept.
//
// So the worker reports its OWN event loop, once a second: a counter that only
// grows. It is NOT a claim about the guest -- the qemu-wasm module can hold this
// thread between yields -- which is why it is published under that name and
// read beside the console's growth, never instead of it. Frozen ticks mean this
// worker is not being scheduled (or the module died); advancing ticks with a
// console that has not moved mean the worker lives and the guest is not
// printing. Either reading is a fact; neither is a diagnosis.
function startHeartbeat() {
  let n = 0;
  setInterval(() => { self.postMessage({ t: 'wtick', n: ++n }); }, 1000);
}

// Boot the guest with per-node config. Called once, on the page's {t:'cfg'} message.
function boot(cfg) {
  if (booted) return; booted = true;
  startHeartbeat();
  const MAC = (cfg && cfg.mac) || '52:54:00:00:00:0A';
  // Per-node initramfs URL (config injection carries CLUSTER_AUTHORIZE.DAT etc.); default = shipped image.
  const INITRAMFS_URL = (cfg && cfg.initramfs) || 'boot/initramfs-ovmx.cpio.gz';
  // The cluster config (VAXCLUSTER=2 etc.) is ODS-2-resident on the SYSTEM DISK, so a
  // config-injected node boots a config-injected sysdisk (default = shipped image).
  const SYSDISK_URL = (cfg && cfg.sysdisk) || 'boot/sysdisk.qcow2.gz';
  self.postMessage({ t: 'out', d: '\r\n%NIC-CFG, initramfs=' + INITRAMFS_URL + ' sysdisk=' + SYSDISK_URL + ' mac=' + MAC + '\r\n' });

  // Install the fake-WebSocket NIC shim BEFORE out.js runs (see header (b)).
  nic = self.OVMXNic.installQemuNicWebSocket({
    scope: self,
    onNicTx: (f) => self.postMessage({ t: 'nic-tx', frame: f.buffer }, [f.buffer]),
    onError: (r) => self.postMessage({ t: 'nic-err', m: '' + r }),
  });

  self.Module = {
    arguments: ['-nographic', '-M', 'pc', '-m', '256M', '-accel', 'tcg,tb-size=500', '-L', '/pack-rom/',
      // ARG FLIP: real virtio-net NIC on a QEMU socket-netdev; SOCKFS is routed through the shim
      // by Module.websocket.url below. connect host:port is a placeholder — the shim owns the wire.
      '-netdev', 'socket,id=vmnic,connect=127.0.0.1:8888',
      '-device', 'virtio-net-pci,netdev=vmnic,mac=' + MAC,
      '-kernel', '/pack-kernel/vmlinuz', '-initrd', '/pack-initramfs/initramfs-ovmx.cpio.gz',
      // no_timer_check (rd vms-4ff) -- the mechanism, now MEASURED rather than
      // reasoned about (OpenVMX tests/lab/captures/vms-4ff-timer-check-20261009/):
      //
      // arch/x86/kernel/apic/io_apic.c check_timer() verifies the legacy timer IRQ
      // with timer_irq_works(), which spins in delay_with_tsc() until 40e9/HZ TSC
      // CYCLES have passed and then demands that jiffies advanced by more than 4.
      // Under TCG the guest TSC advances at HOST WALL-CLOCK rate while the vCPU
      // executes orders of magnitude slower than silicon, so that window is ~18 ms
      // of WALL time in which a software-emulated CPU must take and service FIVE
      // IRQ0 ticks. This worker's TCG loop is one of three heavy Workers
      // timesharing whatever cores the visitor's tab gets, so it cannot -- and the
      // kernel then concludes its own (fully emulated, perfectly good) timer is
      // broken. A/B on the shipped kernel, host qemu + TCG, qemu sharing one core
      // with N spinners: ~6x slowdown tears the IO-APIC pin down and silently
      // re-routes IRQ0 to Virtual Wire; ~12x panics "IO-APIC + timer doesn't
      // work!"; ~12x with this flag boots.
      //
      // This is upstream Linux's own policy for virtual machines, not a hack:
      // arch/x86/kernel/kvm.c and arch/x86/kernel/cpu/vmware.c both set
      // no_timer_check = 1 for guests they identify. A qemu-wasm TCG guest is a
      // virtual machine Linux cannot identify, so it has to be told. The flag's
      // ONLY consumer is timer_irq_works(), so it skips the MEASUREMENT and
      // nothing else -- the IRQ0 route kept is the same IO-APIC pin a correct
      // measurement keeps.
      '-append', 'console=ttyS0 loglevel=3 quiet no_timer_check', '-drive', 'file=/pack-disk/sysdisk.qcow2,format=qcow2,if=virtio', '-no-reboot'],
    // Emscripten SOCKFS opens WebSockets against this base; our shim intercepts the construction.
    websocket: { url: 'ws://ovmx/' },
    locateFile: (p) => new URL('boot/' + p, self.location.href).href + '?v=' + ASSET_VER,
    mainScriptUrlOrBlob: new URL('boot/out.js', self.location.href).href + '?v=' + ASSET_VER,
    pty: slave,
    preRun: [(mod) => {
      mod.addRunDependency('ovmx');
      const mk = (p) => { try { mod.FS.mkdir(p); } catch (e) {} };
      const loaded = [0, 0, 0], total = [0, 0, 0];
      const report = () => {
        const l = loaded[0] + loaded[1] + loaded[2], t = (total[0] + total[1] + total[2]) || (66 * 1048576);
        const f = Math.min(l / t, 1);
        self.postMessage({ t: 'progress', frac: f * 0.85, label: 'Downloading OpenVMX… ' + Math.round(f * 100) + '%' });
      };
      // BOOT_VER busts the HTTP cache on the three boot assets together. The
      // kernel lives at a fixed path (boot/vmlinuz) shared with the homepage
      // PoC, while this page's initramfs/sysdisk are per-node files -- so a
      // returning visitor could otherwise pair a CACHED OLD kernel with a NEW
      // initramfs, and vms.ko is version-locked to its kernel: the executive
      // would simply fail to load. Bump on every boot-asset deploy.
      Promise.all([
        xhrGet('boot/vmlinuz?v=' + BOOT_VER, 0, loaded, total, report),
        xhrGet(INITRAMFS_URL + '?v=' + BOOT_VER, 1, loaded, total, report),
        xhrGet(SYSDISK_URL + '?v=' + BOOT_VER, 2, loaded, total, report),
      ]).then(([k, i, dz]) => {
        self.postMessage({ t: 'progress', frac: 0.88, label: 'Unpacking…' });
        return inflate(dz).then((d) => {
          mk('/pack-kernel'); mk('/pack-initramfs'); mk('/pack-disk');
          mod.FS.writeFile('/pack-kernel/vmlinuz', k);
          mod.FS.writeFile('/pack-initramfs/initramfs-ovmx.cpio.gz', i);
          mod.FS.writeFile('/pack-disk/sysdisk.qcow2', d);
          self.postMessage({ t: 'progress', frac: 0.90, label: 'Starting the machine…' });
          mod.removeRunDependency('ovmx');
        });
      }).catch((e) => self.postMessage({ t: 'err', m: '' + e }));
    }],
    onRuntimeInitialized: () => {
      const op = Module.TTY.stream_ops.poll, pty = Module.pty;
      Module.TTY.stream_ops.poll = function (s, t) {
        if (!pty.readable) return (pty.readable ? 1 : 0) | (pty.writable ? 4 : 0);
        return op.call(s, s, t);
      };
      self.postMessage({ t: 'ready' });
    },
    onExit: (c) => self.postMessage({ t: 'halt', m: 'OpenVMX halted' + (c ? ' (exit ' + c + ')' : '') + '.' }),
    onAbort: () => self.postMessage({ t: 'halt', m: 'OpenVMX stopped unexpectedly.' }),
  };
  importScripts('boot/load-rom.js');             // adds the pc-bios ROM preRun (reads global Module)
  importScripts('boot/out.js?v=' + ASSET_VER);   // runs, inits Module in THIS worker
}

// rd vms-0cd2 per-layer RX diagnostic counters. #49 fixed the readyState root cause but
// stripped these; the first full-page cluster run then flew blind (frames reached the page's
// nicRxCount but the guest executive's SHOW CLUSTER/LOCAL_PORTS rx stayed 0, and nothing on
// the page said which layer dropped them). These + the {t:'nic-rx-ack'} report back let a
// harness bisect "worker never got the postMessage" (nicRxWorkerCount) vs "worker got it but
// the NIC shim was null" (hadNic) vs "deliverToGuest ran but returned false — no active/OPEN
// FakeWebSocket" (nicRxDeliverCalls vs nicRxDeliverOk), from the page side, with no rebuild.
let nicRxWorkerCount = 0, nicRxDeliverCalls = 0, nicRxDeliverOk = 0;

self.onmessage = (e) => {
  const m = e.data;
  if (!m) return;
  if (m.t === 'nic-rx') {
    nicRxWorkerCount++;
    let ok = false;
    if (nic) { nicRxDeliverCalls++; ok = !!nic.deliverToGuest(new Uint8Array(m.frame)); if (ok) nicRxDeliverOk++; }
    self.postMessage({ t: 'nic-rx-ack', worker: nicRxWorkerCount, deliverCalls: nicRxDeliverCalls, deliverOk: nicRxDeliverOk, hadNic: !!nic, ok });
    return;
  }
  if (m.t === 'cfg') { boot(m); return; }
  if (m.t === 'in' && inputHandler) inputHandler(m.d);
  else if (m.t === 'resize' && resizeHandler) resizeHandler({ cols: m.cols, rows: m.rows });
};
