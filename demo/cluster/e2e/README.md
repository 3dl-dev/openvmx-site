# Node-A cluster e2e gate (host-portable)

Boots the config-injected OVMX/x86 node headless, with its virtio NIC bridged to the
in-page L2 hub, and **PASSES iff a real guest-emitted `0x6007` SCA frame reaches the
hub** — never mere netdev link-up. This is the anti-LARP gate for vms-b16 (Node-A NIC)
and doubles as the demo's per-release reproducibility gate (vms-f0f).

## `default-boot-gate.js` — the PRODUCTION-DEFAULT boot gate

A separate, simpler gate: boots demo/cluster/index.html exactly as a live visitor does
(click #bootbtn-a, no `?initramfs=`/`?sysdisk=` overrides), so it exercises whatever
`boot/{vmlinuz,initramfs-ovmx.cpio.gz,sysdisk.qcow2.gz}` the site actually ships — the
same assets the homepage single-node PoC boots too. **PASSES iff the guest's own serial
console prints `Username:`** in the real qemu-wasm/`-accel tcg` path.

Run this (or an equivalent headless-chromium check) before EVERY `boot/` asset deploy.
**A headless-KVM boot proof is not sufficient evidence for this gate** — vms-e287: the
V0.7 deploy in PR #47 was KVM-proven to reach `Username:` on k3s-worker, but hung after
LOGINOUT process creation in this exact real (wasm/TCG) path, never reaching it. KVM's
speed can mask a TCG-timing-sensitive stall that will hang every real visitor's browser.

```
node demo/cluster/e2e/coi-server.js <repo-root> 8123 &
PORT=8123 node demo/cluster/e2e/default-boot-gate.js
```
Writes `default-boot-result.json` `{pass, mountLineAt, acpOkAt, elapsed_s, console_tail}`
plus periodic screenshots to `OUT_DIR` (default: this directory).

## Why not run it on the 11GB dev host
The clustering boot **cannot** use the single-node snapshot-resume (`loadvm`) — live
SCS/VC state can't be frozen per-node — so it's a full ~120s+ wasm TCG cold boot at
256MB guest RAM. A small host OOMs / exit-144s the headless chromium mid-boot. **Run on
a >=48GB host (k3s-worker).** (heavy-runtime rule.) **CPU contention matters too, not
just RAM**: measured 2026-09-19 on a shared dev host running unrelated CPU-bound jobs
(600%+ core usage from other tenants) — Node A's own console capture visibly stalled
early (a fraction of a normal boot's output) while its NIC kept transmitting periodic
HELLOs, and a 15-minute CN=2 attempt against the pinned Node-C volume did not converge.
The mechanism proved real (Node A emitted 247 real `0x6007` HELLOs at the hub trying to
join a genuine VAX/VMS peer) but wall-clock convergence needs an **uncontended** host,
not just a big one.

## Inputs (from the generator / injectors)
A **serve-root** directory containing:
- the demo: `index.html`, `node.html`, `node-worker.js`, `lib/`, `coi-serviceworker.js`
- `boot/` — the release's `vmlinuz`, `out.js`, `qemu-system-x86_64.wasm`, `qemu-system-x86_64.worker.js`, `load-rom.*`, `assets/`
- the **config-injected** images at the top level:
  - `initramfs-ovmx-nodeA.cpio.gz` — carries `/etc/ovmx/cluster_authorize.dat` (group 257)  [inject-cluster-config.sh]
  - `sysdisk-nodeA.qcow2.gz` — ODS-2 disk whose `SYS$SYSTEM:OVMXVMSSYS.PAR` has **VAXCLUSTER=2** + SCSNODE=OVMXA  [ODS-2 injector, vms-f0f]

> The `.PAR` **must** be ODS-2-resident on the sysdisk: the demo reads
> `SYS$SYSTEM:OVMXVMSSYS.PAR` from VDA0:, and `stage_boot_images()` overwrites any
> initramfs `OVMX_SYSGEN_PATH` lever with the disk copy. Injecting only the initramfs
> boots stock (SCSNODE=OVMX, VAXCLUSTER=0) → no SCS → no HELLO.

## Run (container — preferred)
```
docker build -t ovmx-cluster-e2e demo/cluster/e2e
docker run --rm -v <serve-root>:/srv:ro -v <out-dir>:/out -e OUT_DIR=/out \
    ovmx-cluster-e2e /srv initramfs-ovmx-nodeA.cpio.gz sysdisk-nodeA.qcow2.gz
```

## Run (script — host has node + playwright + chromium)
```
PORT=8110 demo/cluster/e2e/run-e2e.sh <serve-root> initramfs-ovmx-nodeA.cpio.gz sysdisk-nodeA.qcow2.gz
```

## Result
- **rc 0** + `e2e-result.json {"pass":true, clustered:true, scaByPort:{…}, acpByPort:{…}}` — **each** node
  showed BOTH a real 0x6007 at the hub AND `acpOk` (the genuine ODS-2 ACP mount). **This is the gate.**
- **rc 2** — some node fell short of BOTH halves. `scaByPort` shows which node(s) lacked a real 0x6007;
  `acpByPort` shows which ran a **host-mode `/vms` facade** (no real ODS-2 ACP mount) rather than the real
  product; `console_tail` shows STARTUP + whether `%OVMX-I-SCSNODE` shows the injected SCSNODE + VAXCLUSTER=2.
- The harness logs a `%NIC-CFG, initramfs=.. sysdisk=.. mac=..` marker at boot per node.

## CN=N (multi-node) gate — the anti-LARP bar
The gate is **per-node** and **sufficient**, not just necessary. PASS iff **EVERY** node in the page's
roster (`window.__roster`) shows BOTH: (a) a real guest-emitted `0x6007` at the hub (the **cluster** is
real) AND (b) `acpOk` — the genuine ODS-2 ACP mount marker (the **product** is real, not a host-mode
`/vms` facade). Never a scripted count. A facade's executive-backed cluster stack can still emit 0x6007,
so (b) is what stops a facade node from passing. Node-A-only run → `roster=[OVMXA]` (the single-node gate). Add the pcjs nodes with the env below and they enter the
roster + must each emit a real 0x6007 for CN=3 to pass:

```
NODE_B='https://vax.3dl.network/machines/dec/vax/browser/ovmx-cluster.html?rom=<ka655x.bin>&diskgz=<OVMX/VAX cluster vol>.gz' \
NODE_C='https://vax.3dl.network/machines/dec/vax/browser/ovmx-cluster.html?rom=<ka655x.bin>&diskgz=<real-VMS 5.5 cluster vol>.gz' \
  run-e2e.sh <serve-root> initramfs-ovmx-nodeA.cpio.gz sysdisk-nodeA.qcow2.gz
```
(`NODE_B`/`NODE_C` route into `index.html?nodeB=..&nodeC=..`, which materialises the staged Node B/C
iframes as `node-pcjs.html?machine=..` ports on the switch — otherwise they stay dormant placeholders.)

`acpOk` for a **real VMS** node (Node C) needed its own tell (pcjsvax-636, 2026-09-19): the two
OVMX-specific ACP_TELL alternatives never appear in genuine VAX/VMS 5.5's boot transcript, so
`acpOk` never fired against the pinned `vms55-nodeC-cluster.dsk.gz` volume until `ovmx-cluster.html`
gained a third alternative — the `"VAX/VMS Version Vn.n-xxx"` boot banner, which only genuine
DEC/VSI OpenVMS prints (OVMX never claims to BE VMS). Fixed upstream in the pcjs fork
(`baron-3dl/pcjs#2`); verified firing at t=18s against the real Node-C boot.

When `NODE_C` is set, `e2e-result.json` also carries `nodeCConsoleTail` — Node C's own console
transcript for the run, captured as a **diagnostic**, not parsed into `pass` (no positive ground
truth for VMS 5.5's cluster-join OPCOM broadcast text has been captured yet — see the vms-735
CN=2 landmark session notes). A CN=2 attempt on 2026-09-19 measured Node A emitting 247 real
`0x6007` HELLOs at the hub (real join *attempt* against the real VAX/VMS peer) but did not observe
Node C register it as a member within 15 minutes on a CPU-contended host — re-run on an
uncontended host before concluding anything about the join itself.

## Env knobs
`DEADLINE_MS` (default 600000), `MAC`, `NODE_B`, `NODE_C` (pcjs cluster-machine URLs), `PORT`, `OUT_DIR`.
