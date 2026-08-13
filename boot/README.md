# site/boot/ — Boot OVMX in a web browser (PoC)

Boots the **real OVMX runtime** — the actual OVMX Linux kernel +
`initramfs-ovmx.cpio.gz` (which loads `vms.ko`, so `/dev/vms` is present and
DCL/RMS/RTL run against the real executive) — under
[`ktock/qemu-wasm`](https://github.com/ktock/qemu-wasm) (QEMU compiled to
WebAssembly), entirely client-side. This is Option 2 from
`docs/design-browser-boot.md`. It is **not** a scripted transcript and not a
server-streamed VM; the guest executes in the tab.

Verified 2026-08-10 in headless Chromium: `crossOriginIsolated === true`,
booted to the `Username:` prompt in **~90 s**, logged in `SYSTEM`/`MANAGER`,
ran `SHOW SYSTEM` / `SHOW TIME` / `WRITE`. See the transcript + screenshots in
this task's evidence.

## Files

| File | Origin | Notes |
|---|---|---|
| `index.html`, `module.js` | ours | page + QEMU argv (mirrors `distro/boot/run-qemu.sh`) |
| `out.js`, `qemu-system-x86_64.wasm` (40.8 MB), `qemu-system-x86_64.worker.js` | **upstream `ktock/qemu-wasm` build** | a build tool, like host `qemu-system-x86_64`; args passed at runtime |
| `load-rom.js`, `load-rom.data` | upstream | pc-bios ROMs matched to the wasm build (`-L /pack-rom/`) |
| `coi-serviceworker.js` | upstream (self-hosted) | COOP/COEP shim for header-less hosts |
| `assets/xterm.js`, `xterm.css`, `xterm-pty.js` | self-hosted (no CDN) | serial console |
| `vmlinuz` (15 MB), `initramfs-ovmx.cpio.gz` (2 MB) | **ours** | fetched in `Module.preRun` and written into the guest FS |
| `sysdisk.qcow2.gz` | **ours** | the pre-installed distribution system disk (`ovmx-distrib.img`) with a `savevm` snapshot baked in at the kernel&rarr;`/init` handoff |

Total ~57 MB. The demo ships a **pre-installed** distribution system disk
(`ovmx-distrib.img`, mastered at build by `vmsfs_master`); the single
bootstrap-only initramfs (`STARTUP.EXE` = `/init` + `vms.ko`/`vmsfs.ko`) mounts
it at `/vms` and finds the full system — `DCL.EXE`, `LOGINOUT.EXE`, `IMGACT.EXE`
and the SYSLIB shareables all come off the disk. Installation is no longer done
by PID 1 (vms-96ec/vms-2f0): the disk arrives already installed, so the boot is
"mount-or-halt", not "first-boot install". The `track-release` CI captures a
`savevm` snapshot at the kernel&rarr;`/init` handoff, so each load **resumes**
into the real OVMX startup dialog (executive attach, `DKA0:` mount, STDRV) and
then the login prompt, instead of a ~70&ndash;90 s cold boot. On the operator
console `LOGINOUT` waits for the operator to strike **RETURN** before it
presents `Username:` (vms-2213) — the classic "press RETURN to log in" console
behaviour; the demo page (`finishResume`) sends that RETURN so the resume lands
at `Username:`, and `tools/webdemo/verify.js` gates each deploy on the startup
dialog actually replaying and reaching `Username:`.
**Provenance note:** the wasm QEMU is reused from upstream rather than compiled
here — productionizing means building it ourselves from `ktock/qemu-wasm` (see
that repo's Dockerfiles) so the whole chain is ours. Reuse is legitimate: it is
the emulator binary booting OUR kernel, analogous to using the distro
`qemu-system-x86_64`.

## Serving

Needs cross-origin isolation (SharedArrayBuffer → MTTCG). Two host modes, both
supported by the same files:

* **Header-capable host** (Cloudflare Pages, Netlify, nginx): send
  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp`. `coi-serviceworker.js` then no-ops.
* **GitHub Pages** (can't set headers): `coi-serviceworker.js` injects them
  client-side and does one silent reload on first visit. It **must** be
  same-origin (it is) — do not load it from a CDN.

Everything is same-origin, so `COEP: require-corp` blocks nothing here.

Local check (what the verification used):
```
python3 coi_server.py 8099 .   # sets COOP/COEP; then open http://localhost:8099/
```

## Rebuilding the OVMX payload

```
docker build -f distro/Dockerfile.bootable -t ovmx-boot .
cid=$(docker create ovmx-boot); docker cp $cid:/boot/vmlinuz vmlinuz
docker cp $cid:/boot/initramfs-ovmx.cpio.gz initramfs-ovmx.cpio.gz; docker rm $cid
```
No changes to `vms.ko`, `libvmssys`, or the executive — this is packaging only.

## Known limits (stated on the page too)

TCG, not KVM — tens of seconds to boot, sluggish interaction. Single node (no
cluster/SCS). Fresh disk each load (persistence via IndexedDB/OPFS is a
follow-up). x86_64 only so far (aarch64/Alpha later). `-smp 1` here vs native
`-smp 2` (a labelled web-demo choice; boot-to-login needs no SMP). Terminal
styling is OVMX web-demo presentation, not asserted VMS-authentic (Rule 8).
