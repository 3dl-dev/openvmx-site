#!/bin/sh
# vendor-pcjs.sh -- copy the pcjs VAX browser runtime (the KA655 machine the
# cluster demo's Node B and Node C boot on) into demo/cluster/pcjs/ at ONE pinned
# pcjs commit, and record that pin in demo/cluster/pcjs/PIN.json.
#
# WHY IT IS VENDORED. The demo used to embed the machine cross-origin from
# vax.3dl.network, which deploys whatever baron-3dl/pcjs master holds the moment
# it is pushed: an emulator change reached visitors with no gate, and the visitor
# gate graded whatever happened to be live there instead of a fixed machine. Served
# from this site at a pinned commit, the emulator is part of the page the gate
# previews and the deploy commits -- the same rule as every OVMX node.
#
# usage: tools/vendor-pcjs.sh <pcjs-git-dir> <commit>
#        tools/vendor-pcjs.sh --check <pcjs-git-dir>   (the tree matches PIN.json)
set -eu

CHECK=0
if [ "${1:-}" = "--check" ]; then CHECK=1; shift; fi
SRC=${1:?usage: vendor-pcjs.sh [--check] <pcjs-git-dir> [commit]}
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEST="$HERE/demo/cluster/pcjs"

if [ "$CHECK" = 1 ]; then
    SHA=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['commit'])" "$DEST/PIN.json")
else
    SHA=$(git -C "$SRC" rev-parse --verify "${2:?commit required}^{commit}")
fi

# The machine page and everything it loads (ES-module closure of
# browser/ovmx-cluster.html + browser/vaxworker.js, plus the KA655 ROM it fetches).
FILES="
machines/dec/vax/browser/ovmx-cluster.html
machines/dec/vax/browser/vaxworker.js
machines/dec/vax/browser/vaxmachine.js
machines/dec/vax/browser/vaxterm.js
machines/dec/vax/browser/imageprovider.js
machines/dec/vax/browser/nic-postmessage-hub.js
machines/dec/vax/browser/ka655x.bin
machines/dec/vax/tests/rommachine.js
machines/dec/vax/modules/v2/bus.js
machines/dec/vax/modules/v2/cdg.js
machines/dec/vax/modules/v2/clk.js
machines/dec/vax/modules/v2/cmctl.js
machines/dec/vax/modules/v2/console.js
machines/dec/vax/modules/v2/control.js
machines/dec/vax/modules/v2/cpu.js
machines/dec/vax/modules/v2/cpustate.js
machines/dec/vax/modules/v2/cqbic.js
machines/dec/vax/modules/v2/cqipc.js
machines/dec/vax/modules/v2/decode.js
machines/dec/vax/modules/v2/defines.js
machines/dec/vax/modules/v2/drom.js
machines/dec/vax/modules/v2/ethlink-hubport.js
machines/dec/vax/modules/v2/ethlink.js
machines/dec/vax/modules/v2/exc.js
machines/dec/vax/modules/v2/fpa.js
machines/dec/vax/modules/v2/idle.js
machines/dec/vax/modules/v2/iprdevice.js
machines/dec/vax/modules/v2/ka655.js
machines/dec/vax/modules/v2/memory.js
machines/dec/vax/modules/v2/message.js
machines/dec/vax/modules/v2/mmu.js
machines/dec/vax/modules/v2/nvr.js
machines/dec/vax/modules/v2/ods2.js
machines/dec/vax/modules/v2/regblock.js
machines/dec/vax/modules/v2/rq.js
machines/dec/vax/modules/v2/ssc.js
machines/dec/vax/modules/v2/strq.js
machines/dec/vax/modules/v2/xq.js
machines/modules/v2/component.js
machines/modules/v2/defines.js
machines/modules/v2/format.js
machines/modules/v2/message.js
machines/modules/v2/pcfs.js
machines/modules/v2/reportapi.js
machines/modules/v2/state.js
machines/modules/v2/strlib.js
machines/modules/v2/weblib.js
LICENSE.txt
"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for f in $FILES; do
    mkdir -p "$TMP/$(dirname "$f")"
    git -C "$SRC" show "$SHA:$f" > "$TMP/$f"
done

if [ "$CHECK" = 1 ]; then
    for f in $FILES; do
        cmp -s "$TMP/$f" "$DEST/$f" || { echo "vendor-pcjs: $f differs from pcjs $SHA"; exit 1; }
    done
    extra=$(cd "$DEST" && find . -type f ! -name PIN.json | sed 's|^\./||' | sort)
    want=$(printf '%s\n' $FILES | sort)
    [ "$extra" = "$want" ] || { echo "vendor-pcjs: demo/cluster/pcjs carries files the pin does not list"; exit 1; }
    echo "vendor-pcjs: demo/cluster/pcjs matches pcjs $SHA"
    exit 0
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$TMP/." "$DEST/"
python3 - "$DEST/PIN.json" "$SHA" <<'EOF'
import json, sys
json.dump({"repo": "https://github.com/baron-3dl/pcjs", "commit": sys.argv[2]},
          open(sys.argv[1], "w"), indent=2)
EOF
echo "vendor-pcjs: demo/cluster/pcjs <- pcjs $SHA"
