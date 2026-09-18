# Portable Node-A cluster e2e gate. The Playwright base image bundles node +
# chromium, so `require('playwright')` and the browser are already present.
# Build:  docker build -t ovmx-cluster-e2e demo/cluster/e2e
# Run:    docker run --rm -v <serve-root>:/srv:ro -v <out>:/out \
#             -e OUT_DIR=/out ovmx-cluster-e2e /srv <initramfs> <sysdisk>
# where <serve-root> holds the demo (index.html/node.html/node-worker.js/lib/),
# a boot/ dir with vmlinuz/out.js/wasm/sysdisk/initramfs, and the config-injected
# initramfs + sysdisk at its top level. PASS (rc 0) = a real 0x6007 SCA frame
# reached the hub. Needs a >=48GB host (the wasm cold boot OOMs a small host).
FROM mcr.microsoft.com/playwright:v1.55.0-jammy
# The playwright base image ships the browsers but not the `playwright` npm pkg
# our harness require()s — install it (matches the browser version).
RUN npm i -g playwright@1.55.0
COPY . /harness/e2e
RUN chmod +x /harness/e2e/run-e2e.sh
ENTRYPOINT ["/harness/e2e/run-e2e.sh"]
CMD ["/srv"]
