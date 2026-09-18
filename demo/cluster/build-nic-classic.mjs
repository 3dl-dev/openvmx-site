// build-nic-classic.mjs — GENERATE lib/nic-classic.js from the two ES-module NIC
// sources so a CLASSIC worker (importScripts) can use the SAME tested transport core.
//
// A classic worker cannot `import`, so we concatenate the tested modules into one
// classic script: read qemu-socket-framing.mjs then qemu-ws-shim.mjs, strip the
// cross-file `import {...} from './qemu-socket-framing.mjs';` line and every leading
// `export `, join framing-first, and expose the API on `self.OVMXNic`. There is ONE
// tested source (the .mjs); drift is caught by test/nic-classic-parity.test.mjs.
//
// Run:  node build-nic-classic.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');

const framing = read('lib/qemu-socket-framing.mjs');
const shim = read('lib/qemu-ws-shim.mjs');

const stripExport = (s) => s.replace(/^export\s+/gm, '');
const stripFramingImport = (s) =>
  s.replace(/^import\s*\{[^}]*\}\s*from\s*'\.\/qemu-socket-framing\.mjs';[ \t]*\r?\n?/gm, '');

const out = [
  '// GENERATED — DO NOT EDIT. Emitted by demo/cluster/build-nic-classic.mjs from',
  '// lib/qemu-socket-framing.mjs + lib/qemu-ws-shim.mjs (the ONE tested source).',
  '// Regenerate: node build-nic-classic.mjs   Parity gate: test/nic-classic-parity.test.mjs',
  '',
  stripExport(framing).trim(),
  '',
  stripExport(stripFramingImport(shim)).trim(),
  '',
  'self.OVMXNic = { enframe, Deframer, installQemuNicWebSocket };',
  '',
].join('\n');

writeFileSync(join(here, 'lib/nic-classic.js'), out);
console.log('wrote lib/nic-classic.js (' + out.length + ' bytes)');
