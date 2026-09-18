# Node-A cluster e2e gate (host-portable)

Boots the config-injected OVMX/x86 node headless, with its virtio NIC bridged to the
in-page L2 hub, and **PASSES iff a real guest-emitted `0x6007` SCA frame reaches the
hub** — never mere netdev link-up. This is the anti-LARP gate for vms-b16 (Node-A NIC)
and doubles as the demo's per-release reproducibility gate (vms-f0f).

## Why not run it on the 11GB dev host
The clustering boot **cannot** use the single-node snapshot-resume (`loadvm`) — live
SCS/VC state can't be frozen per-node — so it's a full ~120s+ wasm TCG cold boot at
256MB guest RAM. A small host OOMs / exit-144s the headless chromium mid-boot. **Run on
a >=48GB host (k3s-worker).** (heavy-runtime rule.)

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

## Env knobs
`DEADLINE_MS` (default 600000), `MAC`, `NODE_B`, `NODE_C` (pcjs cluster-machine URLs), `PORT`, `OUT_DIR`.
