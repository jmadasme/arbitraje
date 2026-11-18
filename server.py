#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Arbitraje USDT — colector local + servidor de la página.

Descarga precios (top of book) y comisiones *declaradas* de retiro de
Binance, Bybit, OKX y Bitget, y los expone normalizados en:

    http://127.0.0.1:8787/api/market

También sirve la página (index.html) desde la misma carpeta, así el
navegador no tiene que pelear con CORS.

Uso:
    python3 server.py                 # servidor en 127.0.0.1:8787
    python3 server.py --snapshot      # genera snapshot.json y sale
    python3 server.py --port 9000
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36")

PRICE_TTL = 5.0      # segundos que se cachean los precios
FEE_TTL = 1800.0     # segundos que se cachean las comisiones de retiro

# --------------------------------------------------------------------------
# Universo de monedas: monedas con retiro barato y par directo contra USDT
# en las 4 plataformas. `pref` = orden de preferencia de red para retirar.
# --------------------------------------------------------------------------
COINS = {
    # Universo pedido: solo BTC contra USDT. USDT se usa para fondear/rebalancear.
    # pref = redes de retiro en orden de preferencia (la primera que exista).
    "BTC": {"name": "Bitcoin", "pref": ["btc", "bitcoin", "lightning"], "eta": 45, "risk": "alto"},
}

# --------------------------------------------------------------------------
# Plataformas. Comisión de trading spot declarada (orden a mercado = taker).
# Comprobado octubre 2026 en las páginas oficiales de comisiones.
# --------------------------------------------------------------------------
VENUES = {
    "binance": {
        "name": "Binance", "taker": 0.0010, "maker": 0.0010, "url": "https://www.binance.com/en/fee/schedule",
        "note": "Spot taker 0.10%. Con pago en BNB: 0.075%.",
        "taker_bnb": 0.00075,
    },
    "bybit": {
        "name": "Bybit", "taker": 0.0010, "maker": 0.0010, "url": "https://www.bybit.com/en/help-center/article/Trading-Fee-Structure",
        "note": "Spot taker 0.10%. Diferencias por par (algunos 0.06%).",
    },
    "okx": {
        "name": "OKX", "taker": 0.0010, "maker": 0.0008, "url": "https://www.okx.com/fees/spot",
        "note": "Spot taker 0.10%, maker 0.08% (nivel 1).",
    },
    "bitget": {
        "name": "Bitget", "taker": 0.0010, "maker": 0.0008, "url": "https://www.bitget.com/fee-schedule",
        "note": "Spot taker 0.10%, maker 0.08%. Descuento con BGB.",
    },
}

# Redes baratas aceptadas para mover USDT de vuelta (rebalanceo).
CHEAP_NETS = ["bsc", "bep20", "plasma", "opbnb", "arbitrum", "optimism",
              "polygon", "matic", "sol", "solana", "trc20", "trx", "base", "avaxc"]

# Comisiones de retiro de USDT que no tienen API pública: valores declarados
# (o estimados) al 2026-10. Todo es editable desde la página.
USDT_WD_FALLBACK = {
    "bybit": [("BEP20", 1.0, "declarado*"), ("TRC20", 1.0, "declarado*")],
    "okx":   [("TRC20", 1.5, "declarado*"), ("BEP20", 1.0, "estimado")],
}

# Multiplicador para estimar comisiones no publicadas vía API.
EST_FACTOR = 1.3

CACHE = {"prices": (0.0, None), "fees": (0.0, None), "market": (0.0, None)}
LOCK = threading.Lock()


# --------------------------------------------------------------------------
# HTTP helper con gzip
# --------------------------------------------------------------------------
def http_json(url, timeout=20, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json, text/plain, */*",
                "Accept-Encoding": "gzip, deflate",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                enc = (r.headers.get("Content-Encoding") or "").lower()
            if enc == "gzip":
                raw = gzip.decompress(raw)
            elif enc == "deflate":
                raw = zlib.decompress(raw, -zlib.MAX_WBITS)
            return json.loads(raw.decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.5 * (i + 1))
    raise last


def _norm(x):
    return "".join(ch for ch in str(x).lower() if ch.isalnum())


def pick_chain(chains, pref):
    """chains: [(nombre, extra)] -> mejor coincidencia según `pref`."""
    for p in pref:
        pn = _norm(p)
        for name, extra in chains:
            nn = _norm(name)
            if pn and (nn == pn or pn in nn):
                return name, extra
    return None, None


# --------------------------------------------------------------------------
# Precios
# --------------------------------------------------------------------------
def prices_binance(coins):
    syms = [c + "USDT" for c in coins]
    q = json.dumps(syms, separators=(",", ":"))
    book = http_json("https://api.binance.com/api/v3/ticker/bookTicker?symbols=" + urllib.parse.quote(q))
    day = http_json("https://api.binance.com/api/v3/ticker/24hr?symbols=" + urllib.parse.quote(q))
    vol = {d["symbol"]: float(d.get("quoteVolume") or 0) for d in day}
    hl = {d["symbol"]: (float(d.get("lowPrice") or 0), float(d.get("highPrice") or 0)) for d in day}
    out = {}
    for b in book:
        c = b["symbol"][:-4]
        out[c] = {
            "bid": float(b["bidPrice"]), "ask": float(b["askPrice"]),
            "bidSz": float(b["bidQty"]), "askSz": float(b["askQty"]),
            "volUsd": vol.get(b["symbol"], 0),
            "lo": hl.get(b["symbol"], (0, 0))[0], "hi": hl.get(b["symbol"], (0, 0))[1],
            "inst": b["symbol"],
        }
    return out


def prices_bybit(coins):
    data = http_json("https://api.bybit.com/v5/market/tickers?category=spot")["result"]["list"]
    want = {c: c + "USDT" for c in coins}
    out = {}
    idx = {d["symbol"]: d for d in data}
    for c, s in want.items():
        d = idx.get(s)
        if not d:
            continue
        out[c] = {
            "bid": float(d["bid1Price"]), "ask": float(d["ask1Price"]),
            "bidSz": float(d.get("bid1Size") or 0), "askSz": float(d.get("ask1Size") or 0),
            "volUsd": float(d.get("turnover24h") or 0),
            "inst": s,
        }
    return out


def prices_okx(coins):
    data = http_json("https://www.okx.com/api/v5/market/tickers?instType=SPOT")["data"]
    idx = {d["instId"]: d for d in data}
    out = {}
    for c in coins:
        inst = c + "-USDT"
        d = idx.get(inst)
        if not d or not d.get("bidPx"):
            continue
        out[c] = {
            "bid": float(d["bidPx"]), "ask": float(d["askPx"]),
            "bidSz": float(d.get("bidSz") or 0), "askSz": float(d.get("askSz") or 0),
            "volUsd": float(d.get("volCcy24h") or 0),
            "inst": inst,
        }
    return out


def prices_bitget(coins):
    data = http_json("https://api.bitget.com/api/v2/spot/market/tickers")["data"]
    idx = {d["symbol"]: d for d in data}
    out = {}
    for c in coins:
        s = c + "USDT"
        d = idx.get(s)
        if not d:
            continue
        out[c] = {
            "bid": float(d["bidPr"]), "ask": float(d["askPr"]),
            "bidSz": float(d.get("bidSz") or 0), "askSz": float(d.get("askSz") or 0),
            "volUsd": float(d.get("usdtVolume") or 0),
            "inst": s,
        }
    return out


PRICE_FETCHERS = {
    "binance": prices_binance,
    "bybit": prices_bybit,
    "okx": prices_okx,
    "bitget": prices_bitget,
}


# --------------------------------------------------------------------------
# Comisiones de retiro declaradas
# --------------------------------------------------------------------------
def fees_binance():
    """API pública de Binance: trae withdrawFee real por moneda/red."""
    data = http_json("https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll")["data"]
    out, usdt = {}, []
    for item in data:
        coin = item["coin"]
        if coin not in COINS and coin != "USDT":
            continue
        nets = []
        for n in item.get("networkList", []):
            if n.get("withdrawEnable") is False:
                continue
            fee = n.get("withdrawFee")
            if fee in (None, ""):
                continue
            nets.append((n.get("network", ""), float(fee), bool(n.get("depositEnable", True))))
        if not nets:
            continue
        if coin == "USDT":
            for name, fee, depos in nets:
                if any(k in _norm(name) for k in CHEAP_NETS):
                    usdt.append((name, fee, depos))
        else:
            name, (fee, depos) = pick_chain([(n[0], (n[1], n[2])) for n in nets], COINS[coin]["pref"])
            if name:
                out[coin] = {"fee": fee, "chain": name, "src": "live", "depositable": depos}
    return out, usdt


def fees_bitget():
    data = http_json("https://api.bitget.com/api/v2/spot/public/coins")["data"]
    out, usdt = {}, []
    for item in data:
        coin = item.get("coin")
        if coin not in COINS and coin != "USDT":
            continue
        chains = []
        for n in item.get("chains", []):
            if n.get("withdrawable") != "true":
                continue
            try:
                fee = float(n.get("withdrawFee") or 0)
            except ValueError:
                continue
            if fee <= 0:
                continue
            chains.append((n.get("chain", ""), fee, n.get("rechargeable") == "true"))
        if not chains:
            continue
        if coin == "USDT":
            for name, fee, depos in chains:
                if any(k in _norm(name) for k in CHEAP_NETS):
                    usdt.append((name, fee, depos))
        else:
            name, extra = pick_chain([(c[0], (c[1], c[2])) for c in chains], COINS[coin]["pref"])
            if name:
                out[coin] = {"fee": extra[0], "chain": name, "src": "live", "depositable": extra[1]}
    return out, usdt


def get_fees():
    """Devuelve (retiros por moneda, retiros de USDT por plataforma)."""
    with LOCK:
        ts, cached = CACHE["fees"]
        if cached and time.time() - ts < FEE_TTL:
            return cached

    wd, usdt_wd, errors = {}, {}, []

    try:
        b, bu = fees_binance()
        wd["binance"] = b
        usdt_wd["binance"] = _cheapest_usdt(bu)
    except Exception as exc:  # noqa: BLE001
        errors.append("comisiones Binance: %s" % exc)

    try:
        g, gu = fees_bitget()
        wd["bitget"] = g
        usdt_wd["bitget"] = _cheapest_usdt(gu)
    except Exception as exc:  # noqa: BLE001
        errors.append("comisiones Bitget: %s" % exc)

    # Sin API pública: valores declarados/estimados (editables en la página)
    for venue, nets in USDT_WD_FALLBACK.items():
        src = nets[0][2] if nets else "declarado*"
        usdt_wd.setdefault(venue, _cheapest_usdt([(n, f, True) for n, f, _ in nets], src))

    # Estimación para lo que no está publicado: la mayor declarada x 1.3
    for coin, meta in COINS.items():
        ref = None
        for venue in ("binance", "bitget"):
            if coin in wd.get(venue, {}):
                ref = wd[venue][coin]["fee"]
                break
        if ref is None:
            continue
        for venue in VENUES:
            if coin in wd.get(venue, {}):
                continue
            wd.setdefault(venue, {})[coin] = {
                "fee": round(ref * EST_FACTOR, 10), "chain": _chain_label(meta.get("pref") or []),
                "src": "estimado", "depositable": True,
            }

    # Red de transferencia de USDT por plataforma (para rebalanceo)
    for venue in VENUES:
        usdt_wd.setdefault(venue, {"chain": "TRC20", "fee": 1.5, "src": "estimado"})

    result = (wd, usdt_wd, errors)
    with LOCK:
        CACHE["fees"] = (time.time(), result)
    return result


def _chain_label(pref):
    if isinstance(pref, dict):
        pref = list(pref.keys())
    pref = [str(p) for p in (pref or [])]
    labels = {
        "btc": "BTC", "bitcoin": "BTC", "eth": "ERC20", "erc20": "ERC20",
        "sol": "SOL", "solana": "SOL", "xrp": "XRP", "trx": "TRC20", "tron": "TRC20",
        "doge": "DOGE", "ada": "ADA", "cardano": "ADA", "avaxc": "AVAX-C",
        "avax": "AVAX-C", "ltc": "LTC", "bch": "BCH", "sui": "SUI", "ton": "TON",
        "atom": "ATOM", "near": "NEAR", "algo": "ALGO", "xlm": "XLM",
        "dot": "Polkadot", "statemint": "Polkadot", "assethub": "Polkadot",
    }
    for p in pref:
        if p in labels:
            return labels[p]
    return pref[0].upper() if pref else "?"


def _cheapest_usdt(nets, src="live"):
    """Retiro de USDT más barato dando prioridad a las redes baratas."""
    if not nets:
        return None
    cheap = [n for n in nets if any(k in _norm(n[0]) for k in CHEAP_NETS)]
    pool = cheap or nets
    chain, fee, _depos = min(pool, key=lambda n: n[1])
    return {"chain": chain, "fee": fee, "src": src}


# --------------------------------------------------------------------------
# Snapshot completo
# --------------------------------------------------------------------------
def build_market(force=False):
    with LOCK:
        ts, cached = CACHE["market"]
        if cached and not force and time.time() - ts < PRICE_TTL:
            return cached

    quotes, errors = {}, []
    coins = list(COINS)

    with LOCK:
        pts, pfees = CACHE["prices"]
        if pfees and not force and time.time() - pts < PRICE_TTL:
            quotes = pfees
    if not quotes:
        results = {}
        threads = []
        def run(vid):
            try:
                results[vid] = PRICE_FETCHERS[vid](coins)
            except Exception as exc:  # noqa: BLE001
                errors.append("precios %s: %s" % (vid, exc))
                results[vid] = {}
        for vid in VENUES:
            t = threading.Thread(target=run, args=(vid,))
            t.start()
            threads.append(t)
        for t in threads:
            t.join()

        for coin in coins:
            row = {}
            for vid in VENUES:
                q = results.get(vid, {}).get(coin)
                if q and q["bid"] > 0 and q["ask"] > 0:
                    row[vid] = q
            if len(row) >= 2:
                quotes[coin] = row
        with LOCK:
            CACHE["prices"] = (time.time(), quotes)

    try:
        wd, usdt_wd, ferr = get_fees()
    except Exception as exc:  # noqa: BLE001
        errors.append("comisiones: %s" % exc)
        wd, usdt_wd, ferr = {}, {}, []
    errors.extend(ferr)

    now = time.time()
    market = {
        "ok": True,
        "ts": int(now * 1000),
        "priceTtl": PRICE_TTL,
        "venues": VENUES,
        "coins": [{"sym": s, "name": COINS[s]["name"], "eta": COINS[s]["eta"],
                   "risk": COINS[s]["risk"]} for s in coins],
        "quotes": quotes,
        "withdraw": wd,
        "withdrawUsdt": usdt_wd,
        "errors": errors,
        "sources": [
            {"name": "Binance API", "url": "https://api.binance.com/api/v3/ticker/bookTicker",
             "usado": "precios + comisiones de retiro (live)"},
            {"name": "Bybit API", "url": "https://api.bybit.com/v5/market/tickers?category=spot",
             "usado": "precios"},
            {"name": "OKX API", "url": "https://www.okx.com/api/v5/market/tickers?instType=SPOT",
             "usado": "precios"},
            {"name": "Bitget API", "url": "https://api.bitget.com/api/v2/spot/market/tickers",
             "usado": "precios + comisiones de retiro (live)"},
        ],
    }
    with LOCK:
        CACHE["market"] = (time.time(), market)
    return market


# --------------------------------------------------------------------------
# Servidor
# --------------------------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):  # silencio en consola
        pass

    def _headers(self, code, ctype, length=None, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", cache)
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._headers(code, "application/json; charset=utf-8", len(body))
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path in ("/api/market", "/api/prices"):
            try:
                self._json(build_market(force=(path == "/api/prices")))
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": str(exc)}, 502)
            return
        if path == "/api/health":
            self._json({"ok": True, "ts": int(time.time() * 1000)})
            return
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()


def snapshot(path):
    market = build_market(force=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(market, fh, ensure_ascii=False, separators=(",", ":"))
    return market


def main():
    ap = argparse.ArgumentParser(description="Colector local de arbitraje USDT")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--snapshot", action="store_true", help="genera snapshot.json y termina")
    ap.add_argument("--out", default=os.path.join(ROOT, "snapshot.json"))
    args = ap.parse_args()

    if args.snapshot:
        m = snapshot(args.out)
        n = sum(len(v) for v in m["quotes"].values())
        print("snapshot.json listo: %d monedas, %d cotizaciones, %d errores" %
              (len(m["quotes"]), n, len(m["errors"])))
        for e in m["errors"]:
            print("  aviso:", e)
        return

    try:
        build_market(force=True)
    except Exception as exc:  # noqa: BLE001
        print("aviso: primera carga con problemas:", exc)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    url = "http://%s:%d/" % (args.host, args.port)
    print("Arbitraje USDT corriendo en %s  (Ctrl+C para detener)" % url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nchao")


if __name__ == "__main__":
    main()
