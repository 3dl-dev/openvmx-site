// qemu-ws-shim.mjs — the in-worker fake WebSocket that turns the QEMU socket-netdev
// stream into per-Ethernet-frame callbacks, and vice versa.
//
// The empirical PROXY_TO_PTHREAD probe (vms-b16) showed QEMU's SOCKFS socket op is
// proxied to the qemu-worker scope, so this shim installs `scope.WebSocket` in
// qemu-worker.js BEFORE importScripts('out.js'). When QEMU's `-netdev socket,connect=`
// opens, Emscripten constructs one WebSocket here instead of a real one:
//   guest TX (framed bytes) -> ws.send() -> Deframer -> onNicTx(frame)
//   onNicRx(frame) -> deliverToGuest() -> enframe -> ws.onmessage -> guest RX
// The frame handoff is the FROZEN L2 contract's unit (a raw Ethernet frame); the
// worker wires onNicTx/onNicRx to postMessage {nic-tx}/{nic-rx} to the iframe,
// which runs connectNicPipe (contract v1) to the parent switch.

import { enframe, Deframer } from './qemu-socket-framing.mjs';

/**
 * @param {object}   opts
 * @param {object}   opts.scope     the global to install WebSocket on (self, in qemu-worker)
 * @param {(frameU8:Uint8Array)=>void} opts.onNicTx  called per Ethernet frame the guest transmits
 * @param {(reason:string)=>void} [opts.onError]     called on a stream desync
 * @returns {{ deliverToGuest:(frame)=>boolean, connected:()=>boolean, uninstall:()=>void }}
 */
export function installQemuNicWebSocket({ scope, onNicTx, onError = null }) {
  if (!scope) throw new TypeError('installQemuNicWebSocket needs a scope');
  if (typeof onNicTx !== 'function') throw new TypeError('onNicTx must be a function');
  let active = null;

  class FakeWebSocket {
    constructor(url) {
      this.url = String(url);
      this.binaryType = 'blob';        // Emscripten overwrites to 'arraybuffer'
      this.readyState = FakeWebSocket.CONNECTING;
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      this._l = { open: [], message: [], error: [], close: [] };
      this._deframer = new Deframer(onError);
      active = this;
      // Open asynchronously: Emscripten waits for the open event before writing.
      queueMicrotask(() => {
        if (this.readyState !== FakeWebSocket.CONNECTING) return;
        this.readyState = FakeWebSocket.OPEN;
        this._emit('open', { type: 'open' });
      });
    }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener(t, fn) { const a = this._l[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
    _emit(t, ev) {
      const h = this['on' + t]; if (typeof h === 'function') h.call(this, ev);
      for (const fn of (this._l[t] || []).slice()) fn.call(this, ev);
    }
    // guest -> us: the QEMU 4-byte-length-framed stream. Deframe to Ethernet frames.
    send(data) {
      const u8 = data instanceof ArrayBuffer ? new Uint8Array(data)
        : (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : (typeof data === 'string' ? new TextEncoder().encode(data) : null));
      if (!u8) return;
      for (const frame of this._deframer.push(u8)) onNicTx(frame);
    }
    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this._emit('close', { type: 'close', wasClean: true });
      if (active === this) active = null;
    }
  }
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  // rd vms-0cd2 ROOT-CAUSE FIX: the WHATWG WebSocket API exposes these readyState
  // constants on INSTANCES (via the interface prototype), not only as static class
  // properties. Emscripten SOCKFS reads them off the live socket object — out.js
  // websocket_sock_ops.poll does `dest.socket.readyState === dest.socket.OPEN` and
  // sendmsg/recvmsg compare `dest.socket.CONNECTING/CLOSING/CLOSED`. With the constants
  // only static, `dest.socket.OPEN` is undefined, so `1 === undefined` is false and
  // SOCKFS.poll NEVER sets POLLOUT for this socket. QEMU opens the socket-netdev fd
  // non-blocking (SOCKFS connect throws EINPROGRESS) and registers net_socket_connect
  // as the fd's WRITE/POLLOUT handler (net/socket.c:444) to detect connect completion;
  // that handler is what calls net_socket_read_poll(true) to install the RX read handler.
  // No POLLOUT => net_socket_connect never fires => recv() is never called even though
  // inbound frames sit in recv_queue and poll() reports POLLIN — the guest never RXes.
  // TX still worked because sendmsg only *throws* on CONNECTING/CLOSING/CLOSED (all
  // `=== undefined` = false) and otherwise falls through to send(). Mirror the spec on
  // the prototype so instance reads resolve. Pure JS — no qemu-wasm rebuild. Proven at
  // the real executive: injected 0x6007 drives SOCKFS mask 65->69 (POLLOUT set), recvmsg
  // is finally called, and SHOW CLUSTER/LOCAL_PORTS rx climbs 0->1 in-browser.
  FakeWebSocket.prototype.CONNECTING = 0;
  FakeWebSocket.prototype.OPEN = 1;
  FakeWebSocket.prototype.CLOSING = 2;
  FakeWebSocket.prototype.CLOSED = 3;

  const prev = scope.WebSocket;
  scope.WebSocket = FakeWebSocket;

  return {
    // us -> guest RX: enframe an Ethernet frame and deliver it as an inbound message.
    deliverToGuest(frame) {
      if (!active || active.readyState !== FakeWebSocket.OPEN) return false;
      active._emit('message', { type: 'message', data: enframe(frame).buffer });
      return true;
    },
    connected: () => !!active && active.readyState === FakeWebSocket.OPEN,
    uninstall: () => { scope.WebSocket = prev; if (active) active.close(); },
  };
}
