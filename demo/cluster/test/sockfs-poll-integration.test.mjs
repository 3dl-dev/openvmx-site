// sockfs-poll-integration.test.mjs — rd vms-0cd2 mechanism proof at the JS boundary.
//
// This drives the VERBATIM Emscripten `websocket_sock_ops.poll` (+ getPeer) copied
// from the shipped boot/out.js against the demo's real FakeWebSocket. QEMU's compiled
// net/socket.c decides connect-completion (and thus whether the RX read handler is
// installed) from the mask this poll returns: POLLOUT(4) fires net_socket_connect,
// which calls net_socket_read_poll(true). Before the fix the shim's FakeWebSocket had
// no instance-visible OPEN constant, so `dest.socket.readyState === dest.socket.OPEN`
// was false and POLLOUT was never set — recv() was never armed. This test proves the
// fix restores POLLOUT, and that a static-only stand-in (the pre-fix shape) does not,
// so the test has real discriminating power.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installQemuNicWebSocket } from '../lib/qemu-ws-shim.mjs';

const POLLIN = 1, POLLOUT = 4, POLLRDNORM = 64, POLLHUP = 16;

// --- VERBATIM from boot/out.js SOCKFS.websocket_sock_ops (getPeer + poll) ---
function makeSockfsPoll() {
  const websocket_sock_ops = {
    getPeer(sock, addr, port) {
      return sock.peers[addr + ":" + port];
    },
    poll(sock) {
      if (sock.type === 1 && sock.server) {
        return sock.pending.length ? (64 | 1) : 0;
      }
      var mask = 0;
      var dest = sock.type === 1 ? websocket_sock_ops.getPeer(sock, sock.daddr, sock.dport) : null;
      if (sock.recv_queue.length || !dest || (dest && dest.socket.readyState === dest.socket.CLOSING) || (dest && dest.socket.readyState === dest.socket.CLOSED)) {
        mask |= (64 | 1);
      }
      if (!dest || (dest && dest.socket.readyState === dest.socket.OPEN)) {
        mask |= 4;
      }
      if ((dest && dest.socket.readyState === dest.socket.CLOSING) || (dest && dest.socket.readyState === dest.socket.CLOSED)) {
        mask |= 16;
      }
      return mask;
    },
  };
  return websocket_sock_ops;
}

// Build the SOCKFS `sock` shape the poll() reads, with a given socket object as the peer.
function makeSock(socketObj) {
  return {
    type: 1,                       // SOCK_STREAM
    server: null,
    recv_queue: [],
    daddr: 'ovmx', dport: 0,
    peers: { 'ovmx:0': { addr: 'ovmx', port: 0, socket: socketObj } },
  };
}

async function openedFakeWs() {
  const scope = {};
  installQemuNicWebSocket({ scope, onNicTx: () => {} });
  const ws = new scope.WebSocket('ws://ovmx:0/');
  await new Promise((r) => queueMicrotask(r)); // shim opens on a microtask
  return ws;
}

test('FIXED FakeWebSocket: SOCKFS.poll asserts POLLOUT once open (arms QEMU connect-completion)', async () => {
  const wso = makeSockfsPoll();
  const ws = await openedFakeWs();
  const sock = makeSock(ws);

  const maskOpen = wso.poll(sock);
  assert.equal(maskOpen & POLLOUT, POLLOUT,
    'POLLOUT must be set when open — this is what fires net_socket_connect -> read_poll(true)');

  // Now a frame arrives (SOCKFS handleMessage would push into recv_queue).
  sock.recv_queue.push({ addr: 'ovmx', port: 0, data: new Uint8Array(60) });
  const maskData = wso.poll(sock);
  assert.equal(maskData & POLLIN, POLLIN, 'POLLIN set with queued data');
  assert.equal(maskData & POLLRDNORM, POLLRDNORM, 'POLLRDNORM set with queued data');
  assert.equal(maskData & POLLOUT, POLLOUT, 'POLLOUT still set (socket open)');
  // Post-fix, open + queued data => 1|64|4 = 69 (the prior lane measured 65 = no POLLOUT).
  assert.equal(maskData, POLLIN | POLLRDNORM | POLLOUT, 'mask == 69 (POLLIN|POLLRDNORM|POLLOUT)');
  assert.notEqual(maskData, 65, 'must NOT be 65 — 65 is the missing-POLLOUT signature of the bug');
});

test('PRE-FIX shape (constants only static) reproduces the bug: no POLLOUT, mask 65', () => {
  // A minimal stand-in matching the OLD FakeWebSocket: OPEN etc. only static on the
  // constructor, so instance reads are undefined.
  function StaticOnlyWS() { this.readyState = 1; /* OPEN */ }
  StaticOnlyWS.OPEN = 1; StaticOnlyWS.CONNECTING = 0; StaticOnlyWS.CLOSING = 2; StaticOnlyWS.CLOSED = 3;
  const ws = new StaticOnlyWS();
  assert.equal(ws.OPEN, undefined, 'reproduces the defect: instance.OPEN is undefined');

  const wso = makeSockfsPoll();
  const sock = makeSock(ws);
  assert.equal(wso.poll(sock) & POLLOUT, 0, 'bug: POLLOUT never set (readyState === undefined is false)');
  sock.recv_queue.push({ addr: 'ovmx', port: 0, data: new Uint8Array(60) });
  assert.equal(wso.poll(sock), 65, 'bug signature: mask 65 (POLLIN|POLLRDNORM), POLLOUT absent');
});
