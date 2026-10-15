// wasm-ring.test.mjs — the JS end of qemu-wasm's wasm-ring buffers (boot/assets/wasm-ring.js).
// The C end is include/qemu/wasm-ring.h in 3dl-dev/qemu-wasm; this test plays
// that end byte-for-byte on a SharedArrayBuffer (same header, same wrap rule).
// Run: node --test demo/cluster/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Ring, HDR } = require('../../../boot/assets/wasm-ring.js');

// A ring as QEMU's wasm_ring_new lays it out, at a non-zero offset in the heap.
function mkRing(cap, at = 64) {
  const buf = new SharedArrayBuffer(at + HDR + cap);
  new Int32Array(buf, at, 4)[2] = cap;
  return { buf, at, ring: new Ring(buf, at) };
}
// The C producer (wasm_ring_put_record / wasm_ring_write), written independently.
function cPut(buf, at, bytes, record) {
  const h = new Int32Array(buf, at, 4), cap = h[2], data = new Uint8Array(buf, at + HDR, cap);
  const head = h[0] >>> 0, space = cap - ((head - (h[1] >>> 0)) >>> 0);
  const payload = record ? new Uint8Array([...new Uint8Array(new Uint32Array([bytes.length]).buffer), ...bytes]) : bytes;
  if (record && space < payload.length) { h[3]++; return false; }
  const n = Math.min(space, payload.length);
  for (let i = 0; i < n; i++) data[(head + i) & (cap - 1)] = payload[i];
  Atomics.store(h, 0, (head + n) | 0);
  return record ? true : n;
}
// The C consumer (wasm_ring_get_record).
function cGet(buf, at) {
  const h = new Int32Array(buf, at, 4), cap = h[2], data = new Uint8Array(buf, at + HDR, cap);
  const tail = h[1] >>> 0, avail = ((h[0] >>> 0) - tail) >>> 0;
  if (avail < 4) return null;
  const lb = new Uint8Array(4);
  for (let i = 0; i < 4; i++) lb[i] = data[(tail + i) & (cap - 1)];
  const len = new DataView(lb.buffer).getUint32(0, true);
  if (avail < 4 + len) return null;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = data[(tail + 4 + i) & (cap - 1)];
  Atomics.store(h, 1, (tail + 4 + len) | 0);
  return out;
}

test('rejects a ring whose capacity is not a power of two', () => {
  const buf = new SharedArrayBuffer(HDR + 24);
  new Int32Array(buf, 0, 4)[2] = 24;
  assert.throws(() => new Ring(buf, 0), /power of two/);
});

test('QEMU -> JS records arrive whole and in order across the wrap', () => {
  const { buf, at, ring } = mkRing(64);
  const sent = [];
  for (let k = 0; k < 40; k++) {
    const f = new Uint8Array(5 + (k % 9)).map((_, i) => (k * 7 + i) & 0xff);
    if (cPut(buf, at, f, true)) sent.push(f);
    if (k % 3 === 2) for (const g of ring.takeRecords()) assert.deepEqual(g, sent.shift());
  }
  for (const g of ring.takeRecords()) assert.deepEqual(g, sent.shift());
  assert.equal(sent.length, 0);
});

test('JS -> QEMU records: putRecord refuses what does not fit, writes nothing partial', () => {
  const { buf, at, ring } = mkRing(32);
  assert.equal(ring.putRecord(new Uint8Array(20).fill(1)), true);
  assert.equal(ring.putRecord(new Uint8Array(20).fill(2)), false);   // 24 used, 24 needed > 8 free
  assert.deepEqual(cGet(buf, at), new Uint8Array(20).fill(1));
  assert.equal(cGet(buf, at), null);
  for (let k = 0; k < 10; k++) {                                       // wraps several times
    const f = new Uint8Array(13).fill(k);
    assert.equal(ring.putRecord(f), true);
    assert.deepEqual(cGet(buf, at), f);
  }
});

test('console bytes both ways, including the wrap and a full ring', () => {
  const { buf, at, ring } = mkRing(16);
  assert.equal(cPut(buf, at, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), false), 10);
  assert.deepEqual(ring.readAll(), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  assert.equal(ring.readAll(), null);
  assert.equal(cPut(buf, at, new Uint8Array(12).fill(7), false), 12);  // crosses the end
  assert.deepEqual(ring.readAll(), new Uint8Array(12).fill(7));
  assert.equal(ring.write(new Uint8Array(20).fill(9)), 16);             // only what fits
  assert.equal(ring.free(), 0);
});

test('head/tail are free-running u32 counters (survive 2^32 wrap)', () => {
  const { buf, at, ring } = mkRing(16);
  const h = new Int32Array(buf, at, 4);
  h[0] = h[1] = -4;                                                     // 0xfffffffc
  assert.equal(cPut(buf, at, new Uint8Array([5, 6, 7, 8, 9, 10]), true), true);
  const got = ring.takeRecords();
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], new Uint8Array([5, 6, 7, 8, 9, 10]));
  assert.equal(ring.used(), 0);
});

test('isWasmfsTag picks the glue from the fork release tag', () => {
  const { isWasmfsTag } = require('../../../boot/assets/wasm-ring.js');
  assert.equal(isWasmfsTag('wasm-wasmfs-pool16'), true);
  assert.equal(isWasmfsTag('wasm-classic-pool16'), false);
  assert.equal(isWasmfsTag(undefined), false);
});

test('bridge: input typed before the console ring exists is delivered when it appears; frames both ways', () => {
  const { bridge, KIND_CHARDEV, KIND_NET } = require('../../../boot/assets/wasm-ring.js');
  const out = [], frames = [];
  let tick = null;
  const br = bridge({ onOut: (b) => out.push(b), onFrame: (f) => frames.push(f), setInterval: (fn) => { tick = fn; } });
  br.consoleIn('ab');
  assert.equal(br.deliverFrame(new Uint8Array([1])), false);           // NIC not up yet
  const at = 64, cap = 64, buf = new SharedArrayBuffer(4 * (at + HDR + cap));
  const offs = [at, at * 2 + HDR + cap, at * 3 + 2 * (HDR + cap), at * 4 + 3 * (HDR + cap)];
  for (const o of offs) new Int32Array(buf, o, 4)[2] = cap;
  br.onRing(KIND_CHARDEV, 0, offs[0], offs[1], buf);
  br.onRing(KIND_NET, 0, offs[2], offs[3], buf);
  assert.deepEqual(new Ring(buf, offs[0]).readAll(), new Uint8Array([97, 98]));
  assert.equal(br.deliverFrame(new Uint8Array([9, 9])), true);
  assert.deepEqual(new Ring(buf, offs[2]).takeRecords(), [new Uint8Array([9, 9])]);
  new Ring(buf, offs[1]).write(new Uint8Array([104, 105]));
  new Ring(buf, offs[3]).putRecord(new Uint8Array([7]));
  tick();
  assert.deepEqual(out, [new Uint8Array([104, 105])]);
  assert.deepEqual(frames, [new Uint8Array([7])]);
});
