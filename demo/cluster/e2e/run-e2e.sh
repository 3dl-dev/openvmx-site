#!/bin/bash
# run-e2e.sh — serve the cluster demo + drive the Node-A e2e boot gate.
# Runs on any host with node + playwright(+chromium). For a small (<48GB) host the
# wasm cold boot OOMs — use a >=48GB host (k3s-worker). See README.md.
#
# Usage: run-e2e.sh <serve-root> [initramfs] [sysdisk]
#   <serve-root> = a dir containing the demo (index.html/node.html/node-worker.js/lib/),
#                  a boot/ dir (or symlink) with vmlinuz/out.js/wasm/..., and the
#                  config-injected initramfs + sysdisk placed at its top level.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${1:?usage: run-e2e.sh <serve-root> [initramfs] [sysdisk]}"
INITRAMFS="${2:-initramfs-ovmx-nodeA.cpio.gz}"
SYSDISK="${3:-sysdisk-nodeA.qcow2.gz}"
PORT="${PORT:-8110}"
COISRV="${COISRV:-$HERE/coi-server.js}"

echo "[e2e] serving $ROOT on :$PORT ; initramfs=$INITRAMFS sysdisk=$SYSDISK"
node "$COISRV" "$ROOT" "$PORT" &
COI=$!
trap 'kill $COI 2>/dev/null || true' EXIT
sleep 2

INITRAMFS="$INITRAMFS" SYSDISK="$SYSDISK" PORT="$PORT" OUT_DIR="${OUT_DIR:-$HERE}" \
  node "$HERE/e2e-boot.js"
RC=$?
echo "[e2e] result -> ${OUT_DIR:-$HERE}/e2e-result.json (rc=$RC)"
exit $RC
