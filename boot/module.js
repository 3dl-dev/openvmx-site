// OVMX browser-boot — QEMU command line.
//
// These arguments MIRROR distro/boot/run-qemu.sh (the native runtime
// invocation) so the browser boots the SAME machine as bare metal: the same
// OVMX Linux kernel, the same initramfs-ovmx.cpio.gz, and — because that
// initramfs loads vms.ko — the same VMS executive reachable via /dev/vms.
// This is the real OVMX runtime (CLAUDE.md Rule 9), not a re-implementation.
//
// Divergences from run-qemu.sh, each an explicit OVMX web-demo choice (labelled
// per Rule 8 — NOT presented as VMS/native-authentic behaviour):
//   * -smp 1 (native uses -smp 2): one vCPU is lighter and more reliable inside
//     a single browser tab under MTTCG. Boot-to-login does not require SMP.
//   * -accel tcg,tb-size=500: TCG is the only accelerator in the browser (no
//     KVM). Native uses host KVM/TCG as available.
//   * the disk is a qcow2 carrying a PRE-BOOTED SNAPSHOT ('ovmx') captured with
//     THIS wasm binary (savevm). We do NOT cold-boot: index.html drives `loadvm`
//     through the QEMU monitor right after SeaBIOS, resuming to the login prompt
//     in a few seconds instead of ~70s. (-loadvm at startup is broken in this
//     wasm build, hence the monitor route.) -m 128M matches the capture.
if (typeof Module === 'undefined') { var Module = {}; }

Module['arguments'] = [
    '-nographic',
    '-M', 'pc',
    '-m', '128M',
    '-accel', 'tcg,tb-size=500',
    '-L', '/pack-rom/',
    '-nic', 'none',
    '-kernel', '/pack-kernel/vmlinuz',
    '-initrd', '/pack-initramfs/initramfs-ovmx.cpio.gz',
    '-append', 'console=ttyS0 loglevel=3 quiet',
    '-drive', 'file=/pack-disk/sysdisk.qcow2,format=qcow2,if=virtio',
    '-no-reboot',
];

// Everything is served from this same directory (site/boot/). Resolve the wasm,
// the pthread worker, and the main script to ABSOLUTE URLs — pthread workers
// import the main script by this value and cannot resolve a bare specifier.
Module['locateFile'] = function (path) { return new URL(path, document.baseURI).href; };
Module['mainScriptUrlOrBlob'] = new URL('out.js', document.baseURI).href;
