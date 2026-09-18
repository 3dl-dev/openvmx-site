// nic-classic-parity.test.mjs — DRIFT GATE for the generated classic NIC bundle.
//
// lib/nic-classic.js is machine-generated from lib/qemu-socket-framing.mjs +
// lib/qemu-ws-shim.mjs so a classic worker can importScripts the SAME tested core.
// This test loads the GENERATED classic bundle in a `{ self:{} }` vm sandbox AND
// imports the ES-module originals, then asserts enframe() and Deframer.push()
// produce BYTE-IDENTICAL results on random inputs and chunkings. If someone edits
// nic-classic.js by hand (or the generator drifts) this goes red.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { enframe as mjsEnframe, Deframer as MjsDeframer } from '../lib/qemu-socket-framing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, '../lib/nic-classic.js'), 'utf8');

// Seed the sandbox with the HOST's typed-array constructors so `instanceof
// Uint8Array` inside the classic bundle matches arrays created out here (avoids
// cross-realm instanceof mismatch). `self` is the install target.
const sandbox = { self: {}, Uint8Array, ArrayBuffer, DataView, TextEncoder, queueMicrotask, TypeError, console };
vm.runInNewContext(code, sandbox);
const Nic = sandbox.self.OVMXNic;

test('generated bundle exposes the OVMXNic API', () => {
  assert.ok(Nic, 'self.OVMXNic present');
  assert.equal(typeof Nic.enframe, 'function');
  assert.equal(typeof Nic.Deframer, 'function');
  assert.equal(typeof Nic.installQemuNicWebSocket, 'function');
});

// deterministic RNG (same LCG the framing test uses)
const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function frame(len, seed) {
  const u8 = new Uint8Array(len);
  for (let i = 0; i < len; i++) u8[i] = (i * 31 + seed * 7 + 1) & 0xff;
  return u8;
}

test('enframe: classic bundle == ES module, byte-identical (300 random frames)', () => {
  const rnd = rng(0xC0FFEE);
  for (let t = 0; t < 300; t++) {
    const f = frame(Math.floor(rnd() * 1600), t);
    assert.deepEqual([...Nic.enframe(f)], [...mjsEnframe(f)], `enframe drift @${t} len=${f.byteLength}`);
  }
});

test('Deframer.push: classic bundle == ES module across random chunkings (200 trials)', () => {
  const rnd = rng(0x5EED42);
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rnd() * 6);
    const frames = [];
    for (let k = 0; k < n; k++) frames.push(frame(Math.floor(rnd() * 1518), trial * 7 + k));
    // reference stream built with the ES-module enframe
    const parts = frames.map(mjsEnframe);
    const total = parts.reduce((s, p) => s + p.byteLength, 0);
    const bytes = new Uint8Array(total);
    let o = 0; for (const p of parts) { bytes.set(p, o); o += p.byteLength; }

    const da = new MjsDeframer(), db = new Nic.Deframer();
    const ga = [], gb = [];
    let off = 0;
    while (off < bytes.byteLength) {
      const sz = 1 + Math.floor(rnd() * 40);
      const end = Math.min(off + sz, bytes.byteLength);
      const chunk = bytes.subarray(off, end);
      for (const fr of da.push(chunk)) ga.push([...fr]);
      for (const fr of db.push(chunk)) gb.push([...fr]);
      off = end;
    }
    assert.deepEqual(gb, ga, `deframer frame drift @trial=${trial}`);
    assert.equal(db.pending, da.pending, `deframer pending drift @trial=${trial}`);
    // and the recovered frames equal the originals (sanity: not both wrong)
    assert.deepEqual(gb, frames.map((f) => [...f]), `deframer lost bytes @trial=${trial}`);
  }
});
