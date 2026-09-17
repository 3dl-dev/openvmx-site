# SEAT D — public website HTML narrative cleanup (vms-40f)

Branch: `cleanup/site-narrative`. SSOT: `data/compat-surface.json` (regen 2026-09-14),
`data/roadmap.json` (regen 2026-09-10), `boot/DEPLOYED_TAG` = `V0.6-16`.

## Page-by-page inventory (found at start of wave 1)

- **index.html** — flagship "Clusters & interoperability" section claimed MSCP-serving
  a genuine ODS-2 volume as **real today**, in three places (a "What's real today"
  bullet, the body paragraph, and the section deck). Contradicted by
  `docs/cluster/index.html` Appendix B.2 ("A node cannot serve a local disk to the
  cluster over MSCP... post-0.6 work") and by `roadmap.json` milestone 0.9's own theme
  ("a voting member joins, **serves genuine ODS-2 storage**... the last features land
  here" — 0.9 is `planned`, not shipped). Also a loose "quorum" bullet that read as
  quorum *enforcement* when the register only backs quorum *computation* (enforcement
  is explicitly not-wired per the cluster manual). System-index card #06 had the same
  "join and serve storage" conflation.
- **docs/installation/index.html** — `tools/check_manual_grounding.py` FAILED: the
  `ovmx:not-yet` manifest deferred `decnet` as not-yet-available, but the register
  marks core DECnet items (routing, NSP transport, node database, outbound SET HOST)
  implemented/verified real. Appendix C's "Networking as a VMS device" bullet also
  named the wrong device face (`EWA0:`, superseded by device-native-naming's `ETH0:`)
  and asserted "DECnet not wired yet" — stale.
- **docs/cluster/index.html** — trademark scrub regression: "OpenVMS" (spelled out,
  not OpenVMX) and "VSI/HPE" appeared four times in Appendix A/1.3/5.3 prose. Also a
  stale/invalid hardcoded `data-ovmx-version` literal `V0.6-1` (not a real tag) vs.
  `V0.6-16` everywhere else.
- **docs/index.html, roadmap/index.html, status/index.html, compat/index.html,
  boot/index.html, social/index.html** — read in full; prose here is either fully
  data-driven (roadmap/status/compat render from the JSON at runtime) or already
  accurate (docs/index.html's cluster blurb already correctly said "quorum/votes and
  serving an ODS-2 volume are not yet enforced" — it was index.html that disagreed).
  No changes made.

## DONE (this wave, all committed)

1. Scrubbed "OpenVMS"/"VSI" → "VMS"/"vendor" in `docs/cluster/index.html` (4 spots).
2. Fixed the `decnet` grounding-tool FAIL: moved `decnet` + `tcpip-services` into the
   installation guide's `ovmx:covers` manifest (both have real implemented/verified
   register items), dropped `decnet` from `ovmx:not-yet`, rewrote the Appendix C
   networking bullet to state what ships (TCP/IP config plane + `ETH0:` NIC; DECnet
   routing/NSP/node-db/SET HOST) instead of the stale "not wired yet" claim, and
   updated the manifest-mapping comment to match.
3. Fixed the stale `V0.6-1` version literal in `docs/cluster/index.html` → `V0.6-16`.
4. Reconciled the index.html/docs-cluster MSCP contradiction: removed the "MSCP-serves
   a genuine ODS-2 volume" over-claim from index.html's "What's real today" list and
   body prose, moved it to "In progress" (matches Appendix B.2 + roadmap 0.9), and
   reworded the "quorum" bullet to "quorum computation" (matches the register; avoids
   implying the enforcement the cluster manual explicitly says is not wired).
5. Fixed system-index card #06 ("Cluster interop") to separate join (real) from
   storage-serving (in active research).

**Verification:**
- `grep -rniE "openvms|\bvsi\b" --include="*.html" .` → zero hits (repo-wide, not just
  the docs/-excluded scope trademark-gate.yml uses).
- `python3 tools/check_manual_grounding.py --surface data/compat-surface.json --manual docs/installation/index.html --manual docs/cluster/index.html`
  → `OK: 2 manual(s) grounded ... (8 facility token(s) checked)`. Was FAILing before
  this wave (STALE decnet deferral).

## REMAINING / NOT DONE

- Did not re-run `check_manual_grounding.py --version <tag>` (edition check) — the
  live CI only passes `--version` on bare major/minor cuts (point releases like the
  current `V0.6-16` skip that gate per `track-release.yml`), so it wasn't exercised.
  Worth a spot-check next time a bare `V0.7`/`V0.8` cut lands.
- Did not touch `social/index.html`'s "made from a real V0.4-6 boot" or index.html's
  VAX-pane `data-vax-demo-version=V0.6-14` literal / `ovmx-vax-v0.6-14.img.gz` URL —
  both are honest labels of specific frozen media assets (task explicitly says don't
  edit boot/ demo assets), and I have no way to verify whether newer VAX captures
  exist without conductor/operator input.
- Did not add anything about SSH (`ssh$remote-login` etc. are implemented/real in the
  register but unmentioned on any page) — that's a content *addition*, not a
  contradiction fix, out of this lane's scope (no gold-plating).
- `docs/cluster/index.html` is not in the `check_manual_grounding.py` invocation used
  by CI (`track-release.yml` / `docs-drift.yml` only check
  `docs/installation/index.html`) even though it carries its own
  `ovmx:covers`/`ovmx:not-yet` manifest. Not fixed — editing CI YAML is outside "HTML
  prose" scope; flagged below for the conductor.
- Full page sweep was prose/grounding-focused; did not audit every DCL command
  example or code block for correctness (out of scope — data/prose contradictions
  only, per the task).

## CONDUCTOR-GATE ITEMS (verify before publish)

1. **`data/roadmap.json` is stale relative to `boot/DEPLOYED_TAG`.** `boot/DEPLOYED_TAG`
   = `V0.6-16`, but `data/roadmap.json`'s `releases[0].tag` = `V0.6-14` and
   `meta.nextPointRelease.version` = `V0.6-15` (already shipped). Both `index.html`
   and `docs/installation/index.html` / `docs/cluster/index.html` pull their
   client-side `data-ovmx-version` override from `roadmap.json` (`meta.currentVersion
   || releases[0].tag`), so **the live rendered version on every page currently
   downgrades to V0.6-14 at runtime** regardless of the static HTML literal (which
   I've set to V0.6-16 to match DEPLOYED_TAG). This is a data-freshness issue, not an
   HTML one — I did not touch `data/*.json` per the hard rule. Needs a `roadmap.json`
   regen (see `data/REFRESH.md`) before this is fully consistent.
2. **`docs/cluster/index.html` isn't wired into any CI grounding/drift gate** — only
   `docs/installation/index.html` is checked by `track-release.yml` and
   `docs-drift.yml`, even though cluster's manifest exists and I've now got it
   passing by hand. A future edit to the cluster manual could go stale silently.
   Recommend adding `--manual docs/cluster/index.html` to both workflow invocations
   (not done here — workflow YAML edits felt outside "HTML prose" lane scope; flagging
   for the conductor to decide).
3. Confirm the MSCP/quorum reconciliation in index.html reads correctly to a human —
   I resolved a real three-way contradiction (index.html vs docs/cluster/index.html
   Appendix B.2 vs roadmap.json milestone 0.9) by deferring the MSCP-serve claim to
   "in progress," but the operator should sanity-check the wording lands the way
   Baron wants the flagship cluster story told.

## NEXT (if another wave is needed)

- Spot check `docs/installation/index.html` chapters 1-4 line-by-line against the
  register (I reviewed the intro/changelog and Appendix C; did not deep-read every
  chapter body).
- Consider whether `social/index.html`'s V0.4-6 demo assets should be regenerated
  (operator call — assets are out of my edit scope).
