# OpenVMX social / promo assets

Ready-to-post demo media for Reddit and LinkedIn, built from the real V0.4-6 boot
recording (`ovmx-boot.mp4`) and the brand card (`og-demo.png`). Regenerate with
`tools/webdemo/build-social.sh` whenever those source assets are refreshed for a
release (they are auto-tracked). Deterministic — same sources produce the same files.

Every asset is hosted: `https://openvmx.3dl.dev/social/<file>`.

## What to post where

| File | Size | Best for |
|---|---|---|
| `demo-landscape-16x9.mp4` | 1920×1080, ~12s | **Reddit** video post; LinkedIn (landscape); YouTube/X. The universal one. |
| `demo-square-1x1.mp4` | 1080×1080, ~12s | **LinkedIn** + **Reddit** mobile feed — square takes the most feed height that both allow. |
| `demo-reddit.gif` | 720×~458, 15fps | **Reddit** inline/autoplay GIF and old.reddit; drop-in comment/thread replies. |
| `card-square-1200×1200.png` | 1:1 | LinkedIn / Reddit **image** post (no video), or thumbnail. |
| `card-portrait-1080×1350.png` | 4:5 | LinkedIn's tallest feed image — max real estate on mobile. |
| `../og-demo.png` | 1200×630 | The **link-preview** card (already the site's OG image) — used automatically when you paste `openvmx.3dl.dev`. |

Each video is: brand title card → the real boot (SYSDISK mount → executive startup →
`INSTALL` of the shareables → `Username:` login) → an end card with the URL. Silent by
design, with an on-screen `openvmx.3dl.dev` watermark, so it reads on muted autoplay
(LinkedIn/Reddit both autoplay muted).

## Suggested copy

**Reddit** (r/programming, r/vintagecomputing, r/osdev):
> I've been building OpenVMX — an OpenVMS-compatible operating environment (DCL, RMS,
> the system services, a kernel executive) with its own userland, running on the Linux
> and NetBSD kernels. It boots to a `Username:` login in about six seconds, and you can
> boot it in your browser. Open source. Video is a real boot. → openvmx.3dl.dev

**LinkedIn**:
> The VMS lineage shaped a generation of fault-tolerant systems, then the hardware got
> abandoned. OpenVMX is an open-source, OpenVMS-compatible environment — the DCL command
> language, Record Management Services, system services, and a kernel executive, with its
> own userland over the Linux/NetBSD kernels, across VAX, Alpha, x86-64 and ARM. It boots
> to a login in seconds — in your browser. openvmx.3dl.dev

Posting is a manual step (external comms). Assets are brand-safe: "OpenVMX" as the name,
"OpenVMS-compatible" as the badge.
