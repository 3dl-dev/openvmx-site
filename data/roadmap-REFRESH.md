# Regenerating `roadmap.json`

`roadmap.json` powers `/roadmap/` and `/status/`. It is a **derived, milestone-level,
trademark-scrubbed** view of the OVMX release board, which lives in the `vms` repo and is
the single source of truth (release milestones are `rel-*` labels; the 1.0-gate epics roll
up over their child items).

Do **not** hand-edit `roadmap.json`. Regenerate it from the `vms` repo.

## One command (from a `vms` checkout at the ref you are publishing)

```sh
# writes <site>/data/roadmap.json (curated + trademark-scrubbed, no internal item IDs)
python3 tools/roadmap/reconcile.py --site-dir /path/to/openvmx-site
```

The tool is stdlib-only (no host installs). It reads one snapshot (`rd list --all --json`),
derives per-milestone and per-workstream status deterministically, and writes the public
JSON here plus the in-repo roadmap doc. See `docs/roadmap-reconcile-workflow.md` in the
`vms` repo for the full workflow and the checkpoint cadence.

## Invariants (must hold after regenerating)

- **`grep -c OpenVMS data/roadmap.json` == 0** and **`grep -cw VSI data/roadmap.json` == 0**.
  The public view carries no vendor trademark and **no internal item IDs** — it is
  milestone-level only (themes, status, progress, releases). Technical facility names
  (DCL, RMS, ODS-2, SCS, MSCP, TCP/IP, DECnet) are expected.
- The pages read the JSON via same-origin `fetch('/data/roadmap.json')` — no build step at
  serve time, no CDN. Keep it same-origin and self-contained.
- Re-running the tool with unchanged rd (and the same `--as-of`) produces byte-identical
  output.
