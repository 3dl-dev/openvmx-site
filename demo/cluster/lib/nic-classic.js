// GENERATED — DO NOT EDIT. Emitted by demo/cluster/build-nic-classic.mjs from
// lib/qemu-socket-framing.mjs + lib/qemu-ws-shim.mjs (the ONE tested source).
// Regenerate: node build-nic-classic.mjs   Parity gate: test/nic-classic-parity.test.mjs

// qemu-socket-framing.mjs — QEMU `socket` netdev stream framing (de/enframe).
//
// QEMU's socket netdev in stream/connect (TCP) mode prefixes each Ethernet frame
// on the wire with a 4-byte BIG-ENDIAN length (net/socket.c net_socket_send: it
// writes htonl(size) then the frame). The transport under it (here the Emscripten
// SOCKFS WebSocket) is a BYTE STREAM, not message-aligned to frames — so inbound
// bytes arrive split and/or coalesced and must be REASSEMBLED. This module is the
// reassembling parser (guest TX → Ethernet frames) and the symmetric writer
// (Ethernet frames → framed bytes for guest RX). Pure, zero-dependency, testable.

const LEN_PREFIX = 4;
// Upper bound on a single framed packet; a declared length beyond this means the
// stream has desynced/corrupted — we reset rather than buffer unbounded.
const MAX_FRAME_BYTES = 65535;

/** Prepend the 4-byte big-endian length: Ethernet frame -> framed bytes. */
function enframe(frame) {
  const u8 = frame instanceof Uint8Array ? frame
    : (frame instanceof ArrayBuffer ? new Uint8Array(frame) : null);
  if (!u8) throw new TypeError('enframe expects a Uint8Array/ArrayBuffer');
  const n = u8.byteLength;
  const out = new Uint8Array(LEN_PREFIX + n);
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  out.set(u8, LEN_PREFIX);
  return out;
}

/**
 * A reassembling deframer for the QEMU socket-netdev stream.
 * Feed arbitrary byte chunks with push(); it returns the complete Ethernet frames
 * recovered so far (each a fresh Uint8Array). Partial data is buffered across calls.
 */
class Deframer {
  /** @param {(reason:string)=>void} [onError] called on a desync (then the buffer resets) */
  constructor(onError = null) {
    this._buf = new Uint8Array(0);
    this._onError = onError;
  }

  /** @param {Uint8Array|ArrayBuffer} chunk  @returns {Uint8Array[]} complete frames */
  push(chunk) {
    const c = chunk instanceof Uint8Array ? chunk
      : (chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : null);
    if (!c) throw new TypeError('push expects a Uint8Array/ArrayBuffer');
    // Append to the running buffer.
    if (this._buf.byteLength === 0) {
      this._buf = c.slice();
    } else {
      const merged = new Uint8Array(this._buf.byteLength + c.byteLength);
      merged.set(this._buf, 0);
      merged.set(c, this._buf.byteLength);
      this._buf = merged;
    }
    const frames = [];
    let off = 0;
    const b = this._buf;
    while (b.byteLength - off >= LEN_PREFIX) {
      const len = ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
      if (len > MAX_FRAME_BYTES) {
        // Desync/corruption: don't buffer unbounded. Report + reset the stream.
        if (this._onError) this._onError(`framed length ${len} exceeds max ${MAX_FRAME_BYTES}`);
        this._buf = new Uint8Array(0);
        return frames;
      }
      if (b.byteLength - off - LEN_PREFIX < len) break;   // frame not fully arrived yet
      frames.push(b.slice(off + LEN_PREFIX, off + LEN_PREFIX + len));
      off += LEN_PREFIX + len;
    }
    // Retain the unconsumed tail.
    this._buf = off === 0 ? b : b.slice(off);
    return frames;
  }

  /** Bytes currently buffered awaiting more input (diagnostics/tests). */
  get pending() { return this._buf.byteLength; }
}

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


/**
 * @param {object}   opts
 * @param {object}   opts.scope     the global to install WebSocket on (self, in qemu-worker)
 * @param {(frameU8:Uint8Array)=>void} opts.onNicTx  called per Ethernet frame the guest transmits
 * @param {(reason:string)=>void} [opts.onError]     called on a stream desync
 * @returns {{ deliverToGuest:(frame)=>boolean, connected:()=>boolean, uninstall:()=>void }}
 */
function installQemuNicWebSocket({ scope, onNicTx, onError = null, onDiag = null }) {
  if (!scope) throw new TypeError('installQemuNicWebSocket needs a scope');
  if (typeof onNicTx !== 'function') throw new TypeError('onNicTx must be a function');
  let active = null;
  const diag = typeof onDiag === 'function' ? onDiag : () => {};

  class FakeWebSocket {
    constructor(url) {
      this.url = String(url);
      this.binaryType = 'blob';        // Emscripten overwrites to 'arraybuffer'
      this.readyState = FakeWebSocket.CONNECTING;
      this._onmessage = null;
      this.onopen = this.onerror = this.onclose = null;
      this._l = { open: [], message: [], error: [], close: [] };
      this._deframer = new Deframer(onError);
      active = this;
      diag({ t: 'construct', url: this.url });
      // Open asynchronously: Emscripten waits for the open event before writing.
      queueMicrotask(() => {
        if (this.readyState !== FakeWebSocket.CONNECTING) return;
        this.readyState = FakeWebSocket.OPEN;
        this._emit('open', { type: 'open' });
      });
    }
    // rd vms-0cd2: an accessor (not a plain field) so we can OBSERVE whether/when
    // Emscripten's SOCKFS actually wires its message handler onto THIS instance
    // (SOCKFS.websocket_sock_ops.handlePeerEvents does `peer.socket.onmessage = fn`
    // right after construction) — a bisection input static reading alone can't give.
    get onmessage() { return this._onmessage; }
    set onmessage(fn) { this._onmessage = fn; diag({ t: 'onmessage-set', hasFn: typeof fn === 'function' }); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener(t, fn) { const a = this._l[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
    _emit(t, ev) {
      const h = this['on' + t];
      const hadHandler = typeof h === 'function';
      if (hadHandler) h.call(this, ev);
      for (const fn of (this._l[t] || []).slice()) fn.call(this, ev);
      return hadHandler;
    }
    // guest -> us: the QEMU 4-byte-length-framed stream. Deframe to Ethernet frames.
    send(data) {
      const u8 = data instanceof ArrayBuffer ? new Uint8Array(data)
        : (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : (typeof data === 'string' ? new TextEncoder().encode(data) : null));
      if (!u8) return;
      // Diagnostic: the RAW on-wire bytes QEMU's own TX write produced, BEFORE we
      // deframe them — the ground truth for what a correctly-framed inbound message
      // must mirror on the RX side (rd vms-0cd2 framing-parity check).
      if (u8.byteLength >= 4) {
        diag({ t: 'send-raw', len: u8.byteLength,
          prefix: [u8[0], u8[1], u8[2], u8[3]],
          declaredLen: ((u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3]) >>> 0 });
      }
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
  // properties. Emscripten SOCKFS reads them off the live socket object, e.g. out.js
  // websocket_sock_ops.poll does `dest.socket.readyState === dest.socket.OPEN` and
  // sendmsg/recvmsg compare against `dest.socket.CONNECTING/CLOSING/CLOSED`. With the
  // constants only static, `dest.socket.OPEN` is undefined, so `1 === undefined` is
  // false: SOCKFS.poll NEVER sets POLLOUT for this socket. QEMU's socket-netdev opens
  // the connection non-blocking (SOCKFS connect throws EINPROGRESS) and registers
  // net_socket_connect as the fd's WRITE/POLLOUT handler (net/socket.c:444) to detect
  // connect completion; that handler is what calls net_socket_read_poll(true) to install
  // the RX read handler. No POLLOUT => net_socket_connect never fires => the read handler
  // is never installed => recv() is never called even though inbound frames sit in
  // recv_queue and poll() reports POLLIN. TX still works because sendmsg only *throws* on
  // CONNECTING/CLOSING/CLOSED (all `=== undefined` = false) and otherwise falls through to
  // send(). Mirror the spec by putting the constants on the prototype too, so instance
  // reads resolve. Pure JS — no qemu-wasm rebuild.
  FakeWebSocket.prototype.CONNECTING = 0;
  FakeWebSocket.prototype.OPEN = 1;
  FakeWebSocket.prototype.CLOSING = 2;
  FakeWebSocket.prototype.CLOSED = 3;

  const prev = scope.WebSocket;
  scope.WebSocket = FakeWebSocket;

  return {
    // us -> guest RX: enframe an Ethernet frame and deliver it as an inbound message.
    // Returns { dispatched, hadHandler }: dispatched = the socket was OPEN and we fired
    // the event; hadHandler = SOCKFS's own onmessage was actually attached to consume it
    // (dispatched-but-no-handler is functionally the same as never having sent it).
    deliverToGuest(frame) {
      if (!active || active.readyState !== FakeWebSocket.OPEN) return false;
      const framed = enframe(frame);
      diag({ t: 'deliver-attempt', len: framed.byteLength,
        prefix: [framed[0], framed[1], framed[2], framed[3]],
        hasOnmessage: typeof active._onmessage === 'function' });
      const hadHandler = active._emit('message', { type: 'message', data: framed.buffer });
      diag({ t: 'deliver-result', hadHandler });
      return hadHandler;
    },
    connected: () => !!active && active.readyState === FakeWebSocket.OPEN,
    uninstall: () => { scope.WebSocket = prev; if (active) active.close(); },
  };
}

self.OVMXNic = { enframe, Deframer, installQemuNicWebSocket };
