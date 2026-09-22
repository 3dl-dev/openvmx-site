// nic-readystate-constants.test.mjs — rd vms-0cd2 regression.
//
// The in-browser cluster demo's RX was dead because the FakeWebSocket exposed the
// WebSocket readyState constants (CONNECTING/OPEN/CLOSING/CLOSED) only as STATIC
// class properties, while Emscripten SOCKFS reads them off the live socket INSTANCE
// (out.js websocket_sock_ops.poll: `dest.socket.readyState === dest.socket.OPEN`).
// `instance.OPEN` resolved to undefined, so `1 === undefined` was false: SOCKFS never
// asserted POLLOUT for the netdev socket, QEMU's async-connect completion handler
// (net/socket.c net_socket_connect, the fd's write/POLLOUT handler) never fired, and
// the RX read handler was never installed — recv() was never called on inbound frames.
//
// This test reproduces the exact SOCKFS expression against the shim's FakeWebSocket,
// and cross-checks it against the platform WebSocket contract when available.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installQemuNicWebSocket } from '../lib/qemu-ws-shim.mjs';

function makeFakeWs() {
  const scope = {};
  installQemuNicWebSocket({ scope, onNicTx: () => {} });
  return new scope.WebSocket('ws://ovmx/');
}

test('readyState constants are visible on the INSTANCE (WHATWG WebSocket contract)', () => {
  const ws = makeFakeWs();
  // These are the exact instance reads SOCKFS performs. Before the fix they were undefined.
  assert.equal(ws.CONNECTING, 0, 'ws.CONNECTING must be instance-visible');
  assert.equal(ws.OPEN, 1, 'ws.OPEN must be instance-visible (SOCKFS.poll POLLOUT gate)');
  assert.equal(ws.CLOSING, 2, 'ws.CLOSING must be instance-visible');
  assert.equal(ws.CLOSED, 3, 'ws.CLOSED must be instance-visible');
});

test('the exact SOCKFS POLLOUT comparison holds once the socket is OPEN', async () => {
  const ws = makeFakeWs();
  // The shim opens asynchronously (queueMicrotask), mirroring a real WebSocket.
  assert.equal(ws.readyState === ws.OPEN, false, 'not OPEN yet while CONNECTING');
  await new Promise((r) => queueMicrotask(r));
  // out.js websocket_sock_ops.poll: `dest.socket.readyState === dest.socket.OPEN` -> POLLOUT.
  assert.equal(ws.readyState === ws.OPEN, true,
    'after open, readyState===OPEN must be true so SOCKFS asserts POLLOUT');
});

test('instance constants match the platform WebSocket, if one exists', () => {
  if (typeof WebSocket !== 'function') return; // older node: skip cross-check
  const ws = makeFakeWs();
  assert.equal(ws.CONNECTING, WebSocket.prototype.CONNECTING ?? WebSocket.CONNECTING);
  assert.equal(ws.OPEN, WebSocket.prototype.OPEN ?? WebSocket.OPEN);
  assert.equal(ws.CLOSING, WebSocket.prototype.CLOSING ?? WebSocket.CLOSING);
  assert.equal(ws.CLOSED, WebSocket.prototype.CLOSED ?? WebSocket.CLOSED);
});
