// wasm-ring.js — the JavaScript end of qemu-wasm's wasm-ring buffers (rd vms-e79).
//
// The WASMFS build of qemu-wasm (3dl-dev/qemu-wasm, fs=wasmfs) keeps all file
// I/O inside Wasm on the QEMU thread that makes it, so nothing is proxied to
// this worker's thread. The console (-chardev wasmring) and the NIC
// (-netdev wasmring) are single-producer/single-consumer rings in QEMU's own
// memory. QEMU announces each pair once through Module.ovmxRing(kind, index,
// inPtr, outPtr, buffer); from then on this side only reads and writes that
// shared memory with Atomics. It never calls into Wasm and QEMU never waits
// for it, so a busy or parked worker thread cannot stall the emulator.
//
// Layout (include/qemu/wasm-ring.h in the fork): u32 head, tail, cap, drops,
// then cap data bytes. head/tail are free-running byte counts. Record rings
// carry [u32 little-endian length][bytes]. "in" is JS -> QEMU, "out" is
// QEMU -> JS.
//
// Classic script (importScripts) and CommonJS (node tests) in one file.
(function (root) {
  'use strict';
  const KIND_CHARDEV = 1, KIND_NET = 2;
  const H_HEAD = 0, H_TAIL = 1, H_CAP = 2, H_DROPS = 3, HDR = 16;

  class Ring {
    constructor(buffer, ptr) {
      if (ptr % 4) throw new RangeError('wasm-ring pointer not 4-aligned: ' + ptr);
      this.i32 = new Int32Array(buffer, ptr, 4);
      this.cap = Atomics.load(this.i32, H_CAP) >>> 0;
      if (!this.cap || (this.cap & (this.cap - 1))) throw new RangeError('wasm-ring cap not a power of two: ' + this.cap);
      this.data = new Uint8Array(buffer, ptr + HDR, this.cap);
      this.mask = this.cap - 1;
    }
    head() { return Atomics.load(this.i32, H_HEAD) >>> 0; }
    tail() { return Atomics.load(this.i32, H_TAIL) >>> 0; }
    drops() { return Atomics.load(this.i32, H_DROPS) >>> 0; }
    used() { return (this.head() - this.tail()) >>> 0; }
    free() { return this.cap - this.used(); }
    _in(pos, bytes) {
      const off = pos & this.mask, first = Math.min(bytes.length, this.cap - off);
      this.data.set(bytes.subarray(0, first), off);
      if (first < bytes.length) this.data.set(bytes.subarray(first), 0);
    }
    _out(pos, n) {
      const out = new Uint8Array(n), off = pos & this.mask, first = Math.min(n, this.cap - off);
      out.set(this.data.subarray(off, off + first), 0);
      if (first < n) out.set(this.data.subarray(0, n - first), first);
      return out;
    }
    // Producer (JS -> QEMU): write as many bytes as fit; returns the count.
    write(bytes) {
      const head = this.head(), n = Math.min(bytes.length, this.cap - ((head - this.tail()) >>> 0));
      this._in(head, bytes.subarray(0, n));
      Atomics.store(this.i32, H_HEAD, (head + n) | 0);
      return n;
    }
    // Consumer (QEMU -> JS): take everything available (or null).
    readAll() {
      const tail = this.tail(), n = (this.head() - tail) >>> 0;
      if (!n) return null;
      const out = this._out(tail, n);
      Atomics.store(this.i32, H_TAIL, (tail + n) | 0);
      return out;
    }
    // Producer: one whole record, or false if it does not fit (nothing written).
    putRecord(frame) {
      const head = this.head(), need = 4 + frame.length;
      if (this.cap - ((head - this.tail()) >>> 0) < need) return false;
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, frame.length, true);
      this._in(head, len);
      this._in(head + 4, frame);
      Atomics.store(this.i32, H_HEAD, (head + need) | 0);
      return true;
    }
    // Consumer: every complete record available, in order.
    takeRecords() {
      const frames = [];
      let tail = this.tail();
      const head = this.head();
      while (((head - tail) >>> 0) >= 4) {
        const len = new DataView(this._out(tail, 4).buffer).getUint32(0, true);
        if (((head - tail) >>> 0) < 4 + len) break;
        frames.push(this._out(tail + 4, len));
        tail = (tail + 4 + len) >>> 0;
      }
      Atomics.store(this.i32, H_TAIL, tail | 0);
      return frames;
    }
  }

  // Which glue is this? The fork's release tag says (track-release stamps it
  // into ASSET_VER): wasm-wasmfs-* builds have the wasmring console + NIC;
  // older wasm-classic-* builds have the JS FS, xterm-pty and SOCKFS.
  const isWasmfsTag = (tag) => /^wasm-wasmfs-/.test(String(tag || ''));

  // QEMU arguments for the console: -nographic stays (graphics=off, so SeaBIOS
  // writes to the serial port) but its stdio ports are redirected: serial +
  // monitor muxed on the wasmring chardev exactly as -nographic muxes them on
  // stdio (Ctrl-A c), parallel port the null device -nographic gives it.
  const CONSOLE_ARGS = ['-nographic', '-chardev', 'wasmring,id=con,mux=on', '-serial', 'chardev:con',
    '-mon', 'chardev=con,mode=readline', '-parallel', 'null'];

  // One emulator's rings, from the JS side: hand bridge.onRing to
  // Module.ovmxRing; console bytes and guest frames come out through onOut /
  // onFrame (polled every intervalMs), keystrokes and frames go in through
  // consoleIn / deliverFrame. Nothing here calls into Wasm.
  function bridge({ onOut, onFrame = null, intervalMs = 10, setInterval: si = setInterval }) {
    const r = { conIn: null, conOut: null, netIn: null, netOut: null };
    let pending = [];
    const enc = new TextEncoder();
    const drain = () => {
      if (r.conOut) { const b = r.conOut.readAll(); if (b) onOut(b); }
      if (r.netOut && onFrame) for (const f of r.netOut.takeRecords()) onFrame(f);
    };
    si(drain, intervalMs);
    return {
      rings: r,
      drain,
      onRing(kind, index, inPtr, outPtr, buffer) {
        if (index !== 0) return;
        if (kind === KIND_CHARDEV) {
          r.conIn = new Ring(buffer, inPtr); r.conOut = new Ring(buffer, outPtr);
          for (const b of pending) r.conIn.write(b);
          pending = [];
        } else if (kind === KIND_NET) {
          r.netIn = new Ring(buffer, inPtr); r.netOut = new Ring(buffer, outPtr);
        }
      },
      consoleIn(d) {
        const b = typeof d === 'string' ? enc.encode(d) : new Uint8Array(d);
        if (r.conIn) r.conIn.write(b); else pending.push(b);
      },
      // false when the NIC is not up yet or its ring is full (the frame is dropped).
      deliverFrame(f) { return !!r.netIn && r.netIn.putRecord(f); },
      nicUp: () => !!r.netIn,
      drops: () => ({ con: r.conOut ? r.conOut.drops() : null, net: r.netOut ? r.netOut.drops() : null }),
    };
  }

  const api = { Ring, KIND_CHARDEV, KIND_NET, HDR, isWasmfsTag, CONSOLE_ARGS, bridge };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OVMXWasmRing = api;
})(typeof self !== 'undefined' ? self : globalThis);
