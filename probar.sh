#!/usr/bin/env bash
# Prueba rápida: recompila la instantánea, incrusta los datos y valida el motor.
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-python3}

echo "== 1/3 instantánea de precios y comisiones =="
"$PY" server.py --snapshot

echo "== 2/3 incrustar instantánea en index.html =="
"$PY" incrustar.py

echo "== 3/3 motor de cálculo (node) =="
node test-engine.js
echo
echo "Todo listo. Abre la página con ./start.sh --open"
