# Regenerating `compat-surface.json`

`compat-surface.json` powers `/compat/` (the Compatibility Surface page). It is a
**derived, trademark-scrubbed** copy of the OVMX Compatibility Surface Register,
which lives in the `vms` repo under `docs/compat/` and is the single source of truth.

Do **not** hand-edit `compat-surface.json`. Regenerate it from the register.

## One command (containerized — no host installs)

From a checkout of the `vms` repo at the tag/branch you want to publish
(e.g. the release tag), run the register generator, then scrub and copy:

```sh
# 1. generate the canonical machine export from the register
docker run --rm -v "$PWD":/w -w /w python:3-slim \
  sh -c 'pip install --quiet pyyaml && python3 tools/compat/render_compat.py'
#    -> writes build/compat-surface.json  (see tool docstring: "machine export (website + corpus lookup)")

# 2. scrub trademarks for the PUBLIC site, stamp the tag, copy into data/
python3 /path/to/openvmx-site/tools/scrub_compat.py build/compat-surface.json \
  /path/to/openvmx-site/data/compat-surface.json --release <tag>
```

`tools/scrub_compat.py` is the one copy of the scrub. It also stamps
`meta.release`, which the vms deploy drift sentinel reads to know which release
the live page reflects. `track-release.yml` runs both steps on every new tag, so
this manual procedure is only for an out-of-band refresh.

## Invariants (must hold after regenerating)

- **`grep -c OpenVMS data/compat-surface.json` == 0** and **`grep -cw VSI ... ` == 0**.
  The public page strips the string "OpenVMS" and vendor names entirely; technical
  facility names (SYS$, LIB$, DCL, RMS, ODS-2, SCS, NISCA, MSCP) are expected.
  `/compat/` also self-checks: `grep -c OpenVMS compat/index.html` must be 0.
- The page reads the JSON via same-origin `fetch('/data/compat-surface.json')` — no
  build step at serve time, no CDN. Keep it same-origin and self-contained.

## Automating on release (optional)

To make `/compat/` track releases automatically, add a step to the deploy workflow
(`.github/workflows/track-release.yml`) that checks out the `vms` repo at the release
tag and runs the two steps above before the Pages deploy. That edit was intentionally
**left out** of this change to avoid colliding with concurrent edits to that workflow;
apply it once the workflow is quiescent.
