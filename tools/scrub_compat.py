#!/usr/bin/env python3
"""scrub_compat.py -- publish the vms compat register export on the public site.

    scrub_compat.py <vms>/build/compat-surface.json data/compat-surface.json --release <tag>

Applies the trademark scrub (no "OpenVMS", no vendor name; see data/REFRESH.md)
and stamps meta.release with the vms tag the register was rendered at, so the
vms deploy drift sentinel (deploy/targets.yaml, site-compat-data) can read
which release the live page reflects. The one copy of the scrub: REFRESH.md
and track-release.yml both call this.
"""
import argparse
import json
import re


def scrub(x):
    x = x.replace('VSI OpenVMS', 'VMS').replace('OpenVMS', 'VMS')
    x = x.replace('VSI-doc', 'vendor-doc').replace('VSI wiki', 'vendor wiki')
    return re.sub(r'\bVSI\b', 'vendor', x)


def walk(o):
    if isinstance(o, dict):
        return {k: walk(v) for k, v in o.items()}
    if isinstance(o, list):
        return [walk(v) for v in o]
    if isinstance(o, str):
        return scrub(o)
    return o


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--release', required=True, help='vms tag the register was rendered at')
    a = ap.parse_args()
    d = walk(json.load(open(a.src)))
    d['meta']['scrubbed'] = 'trademark scrub applied on render (public site)'
    d['meta']['release'] = a.release
    out = json.dumps(d, indent=1)
    if 'OpenVMS' in out or re.search(r'\bVSI\b', out):
        raise SystemExit('scrub_compat: a trademark survived the scrub; refusing to write')
    open(a.dst, 'w').write(out)


if __name__ == '__main__':
    main()
