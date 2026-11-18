#!/usr/bin/env bash
# Levanta el colector local y abre la página de arbitraje.
#   ./start.sh          -> servidor en http://127.0.0.1:8787
#   ./start.sh --open   -> además abre el navegador
set -euo pipefail
cd "$(dirname "$0")"

PY=${PY:-python3}
PORT=${PORT:-8787}

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "No encuentro python3. Instálalo (sudo apt install python3) y vuelve a intentar." >&2
  exit 1
fi

if [ ! -s snapshot.json ]; then
  echo "Generando instantánea inicial de precios y comisiones…"
  "$PY" server.py --snapshot || true
fi

if [ "${1:-}" = "--open" ]; then
  ( sleep 1.5; command -v xdg-open >/dev/null && xdg-open "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || true ) &
fi

echo "Página:      http://127.0.0.1:${PORT}/"
echo "Datos JSON:  http://127.0.0.1:${PORT}/api/market"
echo "Precios en vivo cada 5 s. Ctrl+C para detener."
exec "$PY" server.py --port "$PORT"
