// qemu-worker.js — the whole qemu-wasm module runs in THIS dedicated Web Worker.
// That makes the module's "main browser thread" the worker, not the page — so
// pthread_create and PROXY_TO_PTHREAD-proxied ops target the worker (idle), not
// the page's compositing thread. This is the documented fix for the emscripten
// #14608 deadlock that froze the demo in real (headed) browsers while never
// reproducing headless. xterm stays on the page; only pty bytes + a few control
// messages cross via postMessage.

// Cache-busted payload download with real byte progress (reported to the page).
const ASSET_VER = 'wasm-wasmfs-pool16';  // bump when the qemu-wasm binary changes

// TWO EMULATOR BUILDS (rd vms-e79): ASSET_VER is the qemu-wasm fork release tag,
// stamped by track-release with the binaries. wasm-wasmfs-* = WASMFS (nothing
// proxied to this thread; console on a shared-memory ring, assets/wasm-ring.js);
// otherwise the JS filesystem with xterm-pty's TTY. See
// demo/cluster/node-worker.js for the long version.
importScripts('assets/wasm-ring.js');            // -> self.OVMXWasmRing
const RINGS = self.OVMXWasmRing.isWasmfsTag(ASSET_VER);
let inputHandler = null, resizeHandler = null, slave = null, ring = null;
if (RINGS) {
  ring = self.OVMXWasmRing.bridge({ onOut: (b) => self.postMessage({ t: 'out', d: b }, [b.buffer]) });
  inputHandler = (d) => ring.consoleIn(d);
} else {
  importScripts('assets/xterm-pty.js');          // -> self.openpty
  const pty = openpty();
  slave = pty.slave;
  pty.master.activate({                          // stands in for the page Terminal
    write: (data, cb) => { self.postMessage({ t: 'out', d: data }); if (typeof cb === 'function') cb(); },
    onData: (h) => { inputHandler = h; return { dispose() {} }; },
    onBinary: () => ({ dispose() {} }),
    onResize: (h) => { resizeHandler = h; return { dispose() {} }; },
  });
}
self.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'in' && inputHandler) inputHandler(m.d);
  else if (m.t === 'resize' && resizeHandler) resizeHandler({ cols: m.cols, rows: m.rows });
};
const PAYLOAD_VER = 'V0.7-12-4640';
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

self.Module = {
  arguments: [...(RINGS ? self.OVMXWasmRing.CONSOLE_ARGS : ['-nographic']), '-M', 'pc', '-m', '256M', '-accel', 'tcg,tb-size=500', '-L', '/pack-rom/',
    '-nic', 'none', '-kernel', '/pack-kernel/vmlinuz', '-initrd', '/pack-initramfs/initramfs-ovmx.cpio.gz',
    // no_timer_check (rd vms-4ff): see demo/cluster/node-worker.js's twin comment
    // for the measured mechanism -- check_timer()'s timer_irq_works() demands five
    // serviced IRQ0 ticks inside a window bounded in TSC CYCLES, i.e. ~18 ms of
    // HOST WALL time, which a WASM-hosted TCG vCPU cannot deliver; upstream Linux
    // sets the same flag itself for every KVM/VMware guest (kvm.c, cpu/vmware.c).
    // Its only consumer is that measurement, so nothing else changes.
    '-append', 'console=ttyS0 loglevel=3 quiet no_timer_check', '-drive', 'file=/pack-disk/sysdisk.qcow2,format=qcow2,if=virtio', '-no-reboot'],
  locateFile: (p) => new URL(p, self.location.href).href + '?v=' + ASSET_VER,
  mainScriptUrlOrBlob: new URL('out.js', self.location.href).href + '?v=' + ASSET_VER,
  pty: slave,
  ovmxRing: (...a) => { if (ring) ring.onRing(...a); },
  preRun: [(mod) => {
    mod.addRunDependency('ovmx');
    const loaded = [0, 0, 0], total = [0, 0, 0];
    const report = () => {
      const l = loaded[0] + loaded[1] + loaded[2], t = (total[0] + total[1] + total[2]) || (66 * 1048576);
      const f = Math.min(l / t, 1);
      self.postMessage({ t: 'progress', frac: f * 0.85, label: 'Downloading OpenVMX… ' + Math.round(f * 100) + '%' });
    };
    Promise.all([
      xhrGet('vmlinuz', 0, loaded, total, report),
      xhrGet('initramfs-ovmx.cpio.gz', 1, loaded, total, report),
      xhrGet('sysdisk.qcow2.gz', 2, loaded, total, report),
    ]).then(([k, i, dz]) => {
      self.postMessage({ t: 'progress', frac: 0.88, label: 'Unpacking…' });
      return inflate(dz).then((d) => {
        // Preloaded (both filesystems): WASMFS cannot run Wasm before its runtime is up.
        for (const dir of ['pack-kernel', 'pack-initramfs', 'pack-disk']) mod.FS.createPath('/', dir, true, true);
        mod.FS.createDataFile('/pack-kernel', 'vmlinuz', k, true, true, true);
        mod.FS.createDataFile('/pack-initramfs', 'initramfs-ovmx.cpio.gz', i, true, true, true);
        mod.FS.createDataFile('/pack-disk', 'sysdisk.qcow2', d, true, true, true);
        self.postMessage({ t: 'progress', frac: 0.90, label: 'Starting the machine…' });
        mod.removeRunDependency('ovmx');
      });
    }).catch((e) => self.postMessage({ t: 'err', m: '' + e }));
  }],
  onRuntimeInitialized: () => {
    if (RINGS) { self.postMessage({ t: 'ready' }); return; }
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
importScripts('load-rom.js');   // adds the pc-bios ROM preRun (reads global Module)
importScripts('out.js?v=' + ASSET_VER);        // runs, inits Module in THIS worker
