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
- **rc 0** + `e2e-result.json {"pass":true, sca>0}` — a real 0x6007 frame from the
  guest's PEDRIVER reached the hub. **This is the gate.**
- **rc 2** — booted but no 0x6007 in the deadline. `e2e-result.json.console_tail` shows
  how far STARTUP got + whether SCS/`%OVMX-I-SCSNODE` shows the injected SCSNODE (OVMXA)
  and VAXCLUSTER=2. If SCSNODE=OVMX, the config didn't land (sysdisk not injected).
- The harness logs a `%NIC-CFG, initramfs=.. sysdisk=.. mac=..` marker at boot so you can
  confirm the node booted the injected images.

## Env knobs
`DEADLINE_MS` (default 600000), `MAC` (default `52:54:00:00:00:0A`), `PORT`, `OUT_DIR`.
