// qemu-worker.js — the whole qemu-wasm module runs in THIS dedicated Web Worker.
// That makes the module's "main browser thread" the worker, not the page — so
// pthread_create and PROXY_TO_PTHREAD-proxied ops target the worker (idle), not
// the page's compositing thread. This is the documented fix for the emscripten
// #14608 deadlock that froze the demo in real (headed) browsers while never
// reproducing headless. xterm stays on the page; only pty bytes + a few control
// messages cross via postMessage.

importScripts('assets/xterm-pty.js');            // -> self.openpty
const { master, slave } = openpty();
let inputHandler = null, resizeHandler = null;
const page = {                                   // stands in for the page Terminal
  write: (data, cb) => { self.postMessage({ t: 'out', d: data }); if (typeof cb === 'function') cb(); },
  onData: (h) => { inputHandler = h; return { dispose() {} }; },
  onBinary: () => ({ dispose() {} }),
  onResize: (h) => { resizeHandler = h; return { dispose() {} }; },
};
master.activate(page);
self.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'in' && inputHandler) inputHandler(m.d);
  else if (m.t === 'resize' && resizeHandler) resizeHandler({ cols: m.cols, rows: m.rows });
};

// Cache-busted payload download with real byte progress (reported to the page).
const ASSET_VER = 'cw1';  // bump when the qemu-wasm binary changes
const PAYLOAD_VER = 'V0.4-3-25';
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
  arguments: ['-nographic', '-M', 'pc', '-m', '256M', '-accel', 'tcg,tb-size=500', '-L', '/pack-rom/',
    '-nic', 'none', '-kernel', '/pack-kernel/vmlinuz', '-initrd', '/pack-initramfs/initramfs-ovmx.cpio.gz',
    '-append', 'console=ttyS0 loglevel=3 quiet', '-drive', 'file=/pack-disk/sysdisk.qcow2,format=qcow2,if=virtio', '-no-reboot'],
  locateFile: (p) => new URL(p, self.location.href).href + '?v=' + ASSET_VER,
  mainScriptUrlOrBlob: new URL('out.js', self.location.href).href + '?v=' + ASSET_VER,
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
      xhrGet('vmlinuz', 0, loaded, total, report),
      xhrGet('initramfs-ovmx.cpio.gz', 1, loaded, total, report),
      xhrGet('sysdisk.qcow2.gz', 2, loaded, total, report),
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
importScripts('load-rom.js');   // adds the pc-bios ROM preRun (reads global Module)
importScripts('out.js?v=' + ASSET_VER);        // runs, inits Module in THIS worker
