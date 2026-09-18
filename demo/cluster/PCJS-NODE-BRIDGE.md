# pcjs cluster-node bridge — the HubPort embed contract (for Node B / Node C)

**Status: SPEC + template for the pcjs lane (drop-in when the pcjs VAX machine is browser-embeddable
with its DELQA). Nothing here claims a working cluster — it defines the seam.** Anchor rd vms-735; the
transport contract it rides is `CONTRACT.md` (frozen v1); the reference is the qemu-wasm node
(`node.html` + `node-worker.js`), which this mirrors so **all node families wire identically**.

## The shape (why it's uniform)

Every cluster node — qemu-wasm (Node A) or pcjs (Node B/C) — is an **iframe** that presents its guest's
NIC to the parent page's in-page L2 switch through **one** interface: `connectNicPipe` (contract v1,
`lib/port-postmessage.mjs`). The parent floods raw Ethernet frames between node iframes; each node
bridges its emulator's NIC to `connectNicPipe`:

```
 guest DELQA TX ──► HubPort egress ──► connectNicPipe.nicTx(frame) ──postMessage──► parent switch
 parent switch ──postMessage──► connectNicPipe.toNicRx(frame) ──► HubPort ingress ──► guest DELQA RX
```

`frame` is the **contract-v1 unit**: a raw Ethernet frame (`dst[6] src[6] ethertype[2] payload…`, no
preamble, no FCS), as a `Uint8Array`. The pcjs DELQA `ethlink-hubport.js` already produces/consumes
exactly this (it targets the contract-v1 hub-port API in-process); this contract only re-points its two
directions from the in-process hub to the parent switch.

## What the pcjs lane must deliver (the embed API)

A **cluster-node page** served by the pcjs deployment (e.g. `…/machines/dec/vax/browser/ovmx-cluster.html`,
cross-origin to the demo parent), that:

1. **Boots the pcjs VAX machine with the DELQA** (OVMX/VAX for Node B, real VMS 5.5 for Node C), reading
   its per-node cluster identity from a query param (`?mac=…` and, for OVMX/VAX, the config-injected
   image — Node B rides the same arch-agnostic OVMXVMSSYS.PAR/CLUSTER_AUTHORIZE injection as Node A;
   Node C's pinned VMS volume is pre-configured).

2. **Exposes the DELQA HubPort's two frame hooks** to that page's own JS (the HubPort runs in the pcjs
   machine worker; surface them to the page via the machine's existing worker↔page channel):

   ```js
   // Guest transmitted a frame on the DELQA (guest TX). The page assigns this; the
   // HubPort backend invokes it once per outbound Ethernet frame.
   hubPort.onTx = (frameU8) => { /* page wires -> connectNicPipe.nicTx(frameU8) */ };

   // Deliver an inbound Ethernet frame into the DELQA receive path (guest RX). The
   // HubPort backend implements this; the page calls it for each frame from the switch.
   hubPort.deliverRx(frameU8);   // frameU8: Uint8Array (raw Ethernet frame)
   ```

   Semantics (must hold — they mirror contract-v1 / never-crash-a-peer):
   - `onTx` fires once per complete guest-transmitted Ethernet frame, bytes verbatim.
   - `deliverRx` injects one complete Ethernet frame into the DELQA RX, bytes verbatim; it must **not**
     crash the guest on a malformed/oversized frame (drop it) — Node C is real VMS.
   - No self-hear: the switch already never floods a frame back to its origin port; the HubPort must not
     loop `onTx` frames into `deliverRx` locally.
   - Frame length bounds match `CONTRACT.md` (14 … ~1600 bytes).

3. **Signals readiness**: fire `ovmx-nic-ready` (a DOM event or a `postMessage({t:'nic-ready'})`) once the
   DELQA HubPort is up, so the node page wires the hooks only after they exist.

4. **Signals real-ACP product authenticity** (required for the CN=N gate): post `{t:'nic-ready'}`-style
   `{t:'acp-ok'}` to the parent once the guest console shows the **genuine ODS-2 ACP mount** — the pair
   `%OVMX-I-SYSDISK, mounting system disk <dev>:` → `%OVMX-I-MOUNTED, system disk <dev>: mounted`
   (`<dev>` = VDA0: on VAX / DUA0: on x86). This is the tell a **host-mode `/vms` passthrough facade cannot
   fabricate** — the executive ACP explicitly refuses that masquerade (vms-165 retired passthrough, INV-6).
   The e2e CN=N gate treats a node as clustered ONLY when it has BOTH a real 0x6007 at the hub AND `acp-ok`,
   so a facade filesystem fails the gate even though its (executive-backed) cluster stack can still emit
   0x6007. The machine must run the **real ODS-2 ACP product** (not the host-mode facade) and emit this.

That's the whole contract. It is the pcjs analogue of the qemu-wasm node's
`installQemuNicWebSocket({ onNicTx, deliverToGuest })` (`lib/qemu-ws-shim.mjs`) — same two directions,
same frame unit — so the parent switch and `attachSwitch` treat every node identically.

## The node-page wiring (provided as a template)

`node-pcjs.template.html` is a **reference** node page showing the `connectNicPipe` wiring against the two
hooks above. The pcjs lane either (a) serves it from the demo origin and embeds the pcjs machine as a
nested cross-origin iframe forwarding the hooks, or (b) folds the same ~15 lines of wiring into its own
machine page. Either way the parent (`index.html`) embeds the resulting node URL and `attachSwitch` adds
it as a port — exactly as Node A is added today.

## Integration order (anti-LARP)

1. Node-A live-HELLO proof passes on a capable runner (proves the single-node NIC pattern e2e).
2. pcjs lane makes the machine browser-embeddable with the DELQA + these two hooks (this spec).
3. THEN the node page + `index.html` add Node B/C ports and the real multi-node page — replicating a
   **proven** pattern, never claiming CN=3 before a real 0x6007 frame from each node reaches the hub.
