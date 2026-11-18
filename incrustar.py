#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Incrusta snapshot.json dentro de index.html para que la página funcione
aunque no esté corriendo el colector local."""

import json
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
HTML = os.path.join(ROOT, "index.html")
SNAP = os.path.join(ROOT, "snapshot.json")
PAT = re.compile(r'(<script type="application/json" id="snapshot">).*?(</script>)', re.S)


def main():
    if not os.path.exists(SNAP):
        raise SystemExit("falta snapshot.json (genera con: python3 server.py --snapshot)")
    data = json.dumps(json.load(open(SNAP, encoding="utf-8")),
                      ensure_ascii=False, separators=(",", ":"))
    html = open(HTML, encoding="utf-8").read()
    nuevo, n = PAT.subn(lambda m: m.group(1) + data + m.group(2), html, count=1)
    if n != 1:
        raise SystemExit("no encontré el bloque <script id=\"snapshot\"> en index.html")
    open(HTML, "w", encoding="utf-8").write(nuevo)
    print("instantánea incrustada en index.html (%d KB de datos)" % (len(data) // 1024))


if __name__ == "__main__":
    main()
