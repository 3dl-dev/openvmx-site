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
const PAYLOAD_VER = 'V0.7-1';
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

// Boot the guest with per-node config. Called once, on the page's {t:'cfg'} message.
function boot(cfg) {
  if (booted) return; booted = true;
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
    // rd vms-0cd2: forward the shim's own wiring diagnostics (onmessage-set /
    // send-raw framing / deliver-attempt+result) up to the page for bisection.
    onDiag: (d) => self.postMessage({ t: 'nic-diag', d }),
  });

  self.Module = {
    arguments: ['-nographic', '-M', 'pc', '-m', '256M', '-accel', 'tcg,tb-size=500', '-L', '/pack-rom/',
      // ARG FLIP: real virtio-net NIC on a QEMU socket-netdev; SOCKFS is routed through the shim
      // by Module.websocket.url below. connect host:port is a placeholder — the shim owns the wire.
      '-netdev', 'socket,id=vmnic,connect=127.0.0.1:8888',
      '-device', 'virtio-net-pci,netdev=vmnic,mac=' + MAC,
      '-kernel', '/pack-kernel/vmlinuz', '-initrd', '/pack-initramfs/initramfs-ovmx.cpio.gz',
      '-append', 'console=ttyS0 loglevel=3 quiet', '-drive', 'file=/pack-disk/sysdisk.qcow2,format=qcow2,if=virtio', '-no-reboot'],
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
      Promise.all([
        xhrGet('boot/vmlinuz', 0, loaded, total, report),
        xhrGet(INITRAMFS_URL, 1, loaded, total, report),
        xhrGet(SYSDISK_URL, 2, loaded, total, report),
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

// rd vms-0cd2 diagnostic counters: RX reaches the hub + the page (node.html's own
// nicRxCount) but never showed up at the guest's executive (SHOW CLUSTER/LOCAL_PORTS
// rx stayed 0). These two counters + the {t:'nic-rx-ack'} report back let a harness
// bisect "worker never got the postMessage" vs "worker got it but nic was null" vs
// "deliverToGuest ran but returned false (no active/open FakeWebSocket)" from the
// page side, without needing a second real cluster node.
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
