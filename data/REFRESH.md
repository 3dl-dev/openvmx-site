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

# 2. scrub trademarks for the PUBLIC site and copy into this repo's data/
python3 - <<'PY'
import json, re
d = json.load(open('build/compat-surface.json'))
def scrub(x):
    x = x.replace('VSI OpenVMS', 'VMS').replace('OpenVMS', 'VMS')
    x = x.replace('VSI-doc', 'vendor-doc').replace('VSI wiki', 'vendor wiki')
    return re.sub(r'\bVSI\b', 'vendor', x)
def walk(o):
    if isinstance(o, dict):  return {k: walk(v) for k, v in o.items()}
    if isinstance(o, list):  return [walk(v) for v in o]
    if isinstance(o, str):   return scrub(o)
    return o
d = walk(d)
d['meta']['scrubbed'] = 'trademark scrub applied on render (public site)'
json.dump(d, open('/path/to/openvmx-site/data/compat-surface.json', 'w'), indent=1)
PY
```

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
