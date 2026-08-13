#!/usr/bin/env python3
"""
check_manual_grounding.py - assert the public OpenVMX manuals stay GROUNDED in
the Compatibility Surface Register, so a MAJOR/MINOR release cut can never ship
a manual that documents things that are not implemented, or that is stale about
things that now are.

Companion to check_guide_drift.py (from the vms repo, reused verbatim by
docs-drift.yml). That gate proves the manual's *commands* match the e2e gate
that runs them. THIS gate proves the manual's *capability claims* match the
register. Together they close the "the manual looks tested but isn't checked"
LARP shape, applied to documentation.

THE SOURCE OF TRUTH is the OVMX Compatibility Surface Register in the vms repo
(docs/compat/ -> build/compat-surface.json via tools/compat/render_compat.py).
Every facility carries per-item status (absent < designed < stub < partial <
implemented < verified) and authenticity (real / advisory / facade-risk / n/a).

THE MANIFEST. A manual declares, in a hidden and parseable block (mirroring the
drift gate's hidden 'ovmx:guide-steps' convention), which compat facility tokens
it asserts as working and which it defers as not-yet-available:

    <!-- ovmx:covers:begin -->    facilities the manual states as WORKING
    install
    devices
    <!-- ovmx:covers:end -->
    <!-- ovmx:not-yet:begin -->   facilities the manual DEFERS ("not yet available")
    tcpip-services
    decnet
    <!-- ovmx:not-yet:end -->

One token per line; blank lines and '#'-comment lines are ignored. The tokens
are the facility keys from docs/compat/domains.yaml. This is invisible on the
rendered page (it lives inside a hidden <div>).

THE CHECKS (per manual):
  1. Not-yet staleness: a facility the manual DEFERS must not have genuinely
     shipped. FAIL if any of its items is implemented/verified AND authenticity
     is not facade-risk. (A facade-risk 'implemented' item does NOT count as
     shipped -- deferring a facade is honest, not stale.) If it genuinely
     shipped, the manual is stale: that capability must be documented, or
     removed from the deferral list.
  2. Over-claim: a facility the manual states as WORKING must actually be there.
     FAIL if the register shows it absent/designed/stub, or its only
     implemented/verified items are facade-risk. (partial with a real
     implemented item passes -- "the common case works" is a fair claim.)
  3. Edition: with --version, every data-ovmx-version token in the manual must
     equal the cut version. Without --version (e.g. a docs PR, where there is no
     single cut version) the edition check is skipped and only grounding runs.

Every token in a manifest must exist in the register; an unknown token is a
fixture problem (exit 2), not grounding drift -- the mapping itself is broken.

Usage:
    tools/check_manual_grounding.py --surface build/compat-surface.json \
        --manual docs/installation/index.html [--manual ...] [--version V0.4]

Exit 0 = every manual is grounded (and, with --version, editions match).
Exit 1 = grounding drift (a stale deferral or an over-claim); diagnostic printed.
Exit 2 = a fixture problem (missing/empty manifest, unknown token, unreadable
         surface JSON) -- one side of the comparison could not be built. This is
         NOT the same as "grounding drift found".
"""
import argparse
import json
import re
import sys

# Hidden, parseable manifest blocks (mirror the drift gate's HTML-comment fence).
COVERS_RE = re.compile(
    r"<!--\s*ovmx:covers:begin\s*-->(.*?)<!--\s*ovmx:covers:end\s*-->", re.S)
NOTYET_RE = re.compile(
    r"<!--\s*ovmx:not-yet:begin\s*-->(.*?)<!--\s*ovmx:not-yet:end\s*-->", re.S)
# Edition token: <span data-ovmx-version>V0.4</span> (attribute may carry a value).
VERSION_RE = re.compile(r"data-ovmx-version[^>]*>([^<]*)</span>")

SHIPPED = ("implemented", "verified")
IMMATURE = ("absent", "designed", "stub")


def _tokens(block):
    out = []
    for raw in block.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out


def parse_manifest(path):
    """Return (covers, not_yet, versions) or None if no manifest block at all."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    mc = COVERS_RE.search(text)
    mn = NOTYET_RE.search(text)
    if not mc and not mn:
        return None
    covers = _tokens(mc.group(1)) if mc else []
    not_yet = _tokens(mn.group(1)) if mn else []
    versions = [v.strip() for v in VERSION_RE.findall(text)]
    return covers, not_yet, versions


def load_surface(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    facilities = {}
    for it in data.get("items", []):
        facilities.setdefault(it["facility"], []).append(it)
    return facilities


def facility_view(items):
    """Summarise a facility's items for the grounding rules."""
    statuses = {it.get("status") for it in items}
    # a genuinely-shipped item: implemented/verified AND not a facade.
    shipped_real = any(
        it.get("status") in SHIPPED and it.get("authenticity") != "facade-risk"
        for it in items)
    shipped_any = any(it.get("status") in SHIPPED for it in items)
    has_facade = any(it.get("authenticity") == "facade-risk" for it in items)
    only_immature = statuses and statuses <= set(IMMATURE)
    return {
        "statuses": statuses,
        "shipped_real": shipped_real,
        "shipped_any": shipped_any,
        "has_facade": has_facade,
        "only_immature": only_immature,
    }


def check_manual(path, facilities, version, errs, fails):
    parsed = parse_manifest(path)
    if parsed is None:
        errs.append(
            f"{path}: no <!-- ovmx:covers --> / <!-- ovmx:not-yet --> manifest "
            f"block found -- cannot check grounding")
        return
    covers, not_yet, versions = parsed

    # fixture: every declared token must exist in the register.
    for tok in covers + not_yet:
        if tok not in facilities:
            errs.append(f"{path}: manifest token '{tok}' is not a facility in "
                        f"the register (broken mapping)")
    if errs:
        return

    # 1. not-yet staleness -- deferred facility must not have genuinely shipped.
    for tok in not_yet:
        v = facility_view(facilities[tok])
        if v["shipped_real"]:
            fails.append(
                f"{path}: STALE -- manual defers '{tok}' as not-yet-available, "
                f"but the register marks it implemented/verified (real). "
                f"Document it or drop it from the not-yet list.")

    # 2. over-claim -- asserted-working facility must actually be there.
    for tok in covers:
        v = facility_view(facilities[tok])
        if v["only_immature"]:
            fails.append(
                f"{path}: OVER-CLAIM -- manual states '{tok}' works, but the "
                f"register shows only {sorted(v['statuses'])} "
                f"(absent/designed/stub). Remove the claim or fix the register.")
        elif not v["shipped_real"] and v["shipped_any"] and v["has_facade"]:
            fails.append(
                f"{path}: OVER-CLAIM -- manual states '{tok}' works, but its "
                f"only implemented/verified item(s) are facade-risk (INV-6). "
                f"Do not document a facade as working.")
        elif not v["shipped_real"]:
            fails.append(
                f"{path}: OVER-CLAIM -- manual states '{tok}' works, but the "
                f"register has no implemented/verified real item for it "
                f"({sorted(v['statuses'])}).")

    # 3. edition -- only when a cut version is supplied.
    if version is not None:
        if not versions:
            errs.append(f"{path}: --version given but no data-ovmx-version token "
                        f"found in the manual")
        for got in versions:
            if got != version:
                fails.append(
                    f"{path}: EDITION -- data-ovmx-version is '{got}', cut is "
                    f"'{version}'. The 'Applies to' edition must match the cut.")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--surface", required=True,
                    help="compat-surface.json rendered from the vms register")
    ap.add_argument("--manual", required=True, action="append",
                    help="a manual HTML file to check (repeatable)")
    ap.add_argument("--version", default=None,
                    help="cut version (e.g. V0.4); enables the edition check")
    args = ap.parse_args()

    try:
        facilities = load_surface(args.surface)
    except (OSError, ValueError) as e:
        print(f"FATAL: cannot read surface JSON {args.surface}: {e}",
              file=sys.stderr)
        return 2
    if not facilities:
        print(f"FATAL: {args.surface} has no facilities/items -- nothing to "
              f"check manuals against", file=sys.stderr)
        return 2

    errs, fails = [], []
    for m in args.manual:
        try:
            check_manual(m, facilities, args.version, errs, fails)
        except OSError as e:
            errs.append(f"{m}: cannot read manual: {e}")

    if errs:
        print("FATAL: manual-grounding fixture problem:", file=sys.stderr)
        for e in errs:
            print(f"  - {e}", file=sys.stderr)
        return 2

    if fails:
        print(f"FAIL: manual grounding drift ({len(fails)} issue(s)) -- a manual "
              f"disagrees with the Compatibility Surface Register", file=sys.stderr)
        for f in fails:
            print(f"  - {f}", file=sys.stderr)
        return 1

    n_tok = sum(len(parse_manifest(m)[0]) + len(parse_manifest(m)[1])
                for m in args.manual)
    print(f"OK: {len(args.manual)} manual(s) grounded against {args.surface} "
          f"({n_tok} facility token(s) checked"
          + (f", edition {args.version}" if args.version else "") + ")")
    return 0


if __name__ == "__main__":
    sys.exit(main())
