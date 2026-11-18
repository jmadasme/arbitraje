/* engine.js — motor de cálculo de arbitraje entre plataformas.
 * Sin DOM: se puede probar con node (module.exports) o usar en el navegador (window.Arb).
 *
 * Modelo de un ciclo (market orders, taker en ambas puntas):
 *   1) compras la moneda en A  -> gastas USDT, pagas feeA
 *   2) retiras la moneda A->B  -> pagas la comisión de red en monedas
 *   3) vendes la moneda en B   -> recibes USDT, pagas feeB
 *   4) rebalanceas USDT B->A   -> pagas la comisión de retiro de USDT
 * El neto es: USDT recibido - USDT gastado - comisión de red - rebalanceo.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.Arb = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = {
    balances: { binance: 500, bybit: 500, okx: 500, bitget: 500 },
    venuesOff: [],              // plataformas apagadas
    takerOverride: {},          // { venue: 0.001 }
    useTokenDiscount: {},       // { binance: true } -> BNB
    maxTradeUsd: 500,           // tope por operación
    slippagePct: 0.01,          // % por punta (fricción de la orden a mercado)
    slippageOn: true,
    useBookDepth: false,        // recorta el tramo al primer nivel del libro (conservador)
    includeRebalance: true,     // suma el retiro de USDT de vuelta
    rebalanceBatch: 1,          // cada cuántos ciclos rebalanceas la moneda (amortiza la red)
    includeClp: false,          // incluir el tramo CLP -> USDT -> CLP en el ciclo
    clpBuyPct: 0.5,             // % que pierdes comprando USDT con CLP (P2P/ramp)
    clpSellPct: 0.5,            // % que pierdes vendiendo USDT por CLP
    clpBatch: 1,                // cada cuántos ciclos vuelves a CLP
    minNetUsd: 0.50,            // umbral de ganancia por ciclo
    minNetBps: 15,              // umbral en bps sobre el tramo
    riskPenalty: false,         // resta la deriva esperada del precio
    genericWdPct: 0.10,         // % del nocional si no hay dato de comisión de red
        feeOverrides: {},       // "venue|MONEDA": { fee, chain }
    historyMax: 400
  };

  // ---------------------------------------------------------------- utils
  const num = (v, d = 2) => (v === null || v === undefined || isNaN(v)) ? '—' :
    Number(v).toLocaleString('es-CL', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usd = (v, d = 2) => (v === null || v === undefined || isNaN(v)) ? '—' : (v < 0 ? '-$' : '$') + num(Math.abs(v), d);
  const sgn = (v, d = 2) => (v === null || v === undefined || isNaN(v)) ? '—' : (v > 0 ? '+' : '') + usd(v, d);
  const bps = (v, d = 1) => (v === null || v === undefined || isNaN(v)) ? '—' : (v > 0 ? '+' : '') + num(v, d) + ' bps';
  const pct = (v, d = 2) => (v === null || v === undefined || isNaN(v)) ? '—' : (v > 0 ? '+' : '') + num(v, d) + '%';
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('es-CL', { hour12: false });
  const fmtDT = (ts) => new Date(ts).toLocaleString('es-CL', { hour12: false });
  const dur = (sec) => sec == null ? '—' : (sec < 60 ? sec + ' s' : (sec < 3600 ? Math.round(sec / 60) + ' min' : num(sec / 3600, 1) + ' h'));

  // ------------------------------------------------------- resolveFees()
  // Devuelve las tablas efectivas de comisiones, ya con overrides y estimaciones.
  function resolveFees(data, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    const venues = data.venues || {};
    const off = new Set(cfg.venuesOff || []);

    const taker = {}, venueInfo = {};
    for (const vid of Object.keys(venues)) {
      const v = venues[vid];
      let t = v.taker;
      if (cfg.takerOverride && cfg.takerOverride[vid] != null) t = cfg.takerOverride[vid];
      else if (cfg.useTokenDiscount && cfg.useTokenDiscount[vid] && v.taker_bnb != null) t = v.taker_bnb;
      taker[vid] = t;
      venueInfo[vid] = { id: vid, name: v.name, taker: t, note: v.note, url: v.url, off: off.has(vid) };
    }

    // comisiones de retiro por moneda (monedas de la moneda)
    const wd = {};
    const declaredByCoin = {};
    for (const vid of Object.keys(venues)) {
      const src = (data.withdraw || {})[vid] || {};
      for (const [coin, e] of Object.entries(src)) {
        (declaredByCoin[coin] = declaredByCoin[coin] || []).push(e.fee);
      }
    }
    const estimados = [];
    for (const c of (data.coins || [])) {
      const coin = c.sym;
      wd[coin] = {};
      for (const vid of Object.keys(venues)) {
        if (off.has(vid)) continue;
        const base = ((data.withdraw || {})[vid] || {})[coin];
        let entry = base ? { fee: base.fee, chain: base.chain, src: base.src || 'declarado' } : null;
        const ov = cfg.feeOverrides[vid + '|' + coin];
        if (ov && ov.fee != null && ov.fee !== '') entry = { fee: Number(ov.fee), chain: ov.chain || (entry && entry.chain) || '?', src: 'manual' };
        if (!entry) {
          const ref = declaredByCoin[coin];
          if (ref && ref.length) {
            entry = { fee: Math.max.apply(null, ref) * 1.3, chain: '≈', src: 'estimado' };
          } else {
            entry = { fee: null, chain: '≈', src: 'asumido', pctNotional: cfg.genericWdPct / 100 };
          }
          estimados.push(coin + ' @ ' + venueInfo[vid].name);
        }
        wd[coin][vid] = entry;
      }
    }

    // retiro de USDT (rebalanceo)
    const usdt = {};
    for (const vid of Object.keys(venues)) {
      const e = (data.withdrawUsdt || {})[vid] || { chain: 'TRC20', fee: 1.5, src: 'asumido' };
      usdt[vid] = { fee: e.fee, chain: e.chain, src: e.src };
    }

    return { taker, venueInfo, wd, usdt, estimados, cfg };
  }

  // ------------------------------------------------------------ una pata
  function opportunity(coin, A, B, data, fees) {
    const cfg = fees.cfg;
    const q = data.quotes[coin];
    if (!q || !q[A] || !q[B]) return null;
    const ask = q[A].ask, bid = q[B].bid;
    if (!(ask > 0) || !(bid > 0)) return null;

    const feeA = fees.taker[A], feeB = fees.taker[B];

    // --- tamaño ejecutable y slippage
    const balA = cfg.balances[A] == null ? 0 : Number(cfg.balances[A]);
    let cap = balA;
    if (cfg.maxTradeUsd > 0) cap = Math.min(cap, cfg.maxTradeUsd);
    let depthCap = Infinity;
    if (q[A].askSz > 0) depthCap = Math.min(depthCap, q[A].askSz * ask);
    if (q[B].bidSz > 0) depthCap = Math.min(depthCap, q[B].bidSz * bid);
    let limitedBy = cap + 1e-9 >= (cfg.maxTradeUsd || Infinity) ? 'tope' : 'inventario';
    if (cfg.useBookDepth && cap > depthCap) { cap = Math.min(cap, depthCap); limitedBy = 'libro'; }
    if (!(cap > 1)) return null;

    // fricción base por punta; si el tramo supera el primer nivel del libro se
    // amplifica (no vemos los niveles siguientes: estimación conservadora)
    const overBook = (depthCap > 0 && isFinite(depthCap)) ? cap / depthCap : 1;
    if (overBook > 1 && limitedBy !== 'libro') limitedBy = 'libro+';
    const slipMult = Math.min(4, 1 + 2 * Math.max(0, overBook - 1));
    const slip = (cfg.slippageOn ? cfg.slippagePct / 100 : 0) * slipMult;
    const buyPx = ask * (1 + slip);
    const sellPx = bid * (1 - slip);

    const spent = cap;                          // USDT que salen del bolsillo
    const notional = spent / (1 + feeA);        // USDT a precio de mercado
    const qty = notional / buyPx;               // monedas compradas
    const buyFeeUsd = notional * feeA;

    // --- comisión de red (en monedas, valorizada al precio de venta)
    const w = (fees.wd[coin] || {})[A] || { fee: null, src: 'asumido' };
    const wCoins = w.fee != null ? w.fee : (w.pctNotional || 0) * notional / ask;
    const batch = Math.max(1, Number(cfg.rebalanceBatch) || 1);   // rebalanceo por lotes
    const wUsd = wCoins * sellPx / batch;

    const grossProceeds = qty * sellPx;
    const sellFeeUsd = grossProceeds * feeB;
    const proceeds = grossProceeds - sellFeeUsd;

    const reb = cfg.includeRebalance ? ((fees.usdt[B] || {}).fee || 0) : 0;
    // tramo CLP: comprar USDT con CLP y devolver USDT a CLP (opcional, amortizable)
    const clpBps = cfg.includeClp
      ? (Number(cfg.clpBuyPct) + Number(cfg.clpSellPct)) / 100 * 10000 / Math.max(1, Number(cfg.clpBatch) || 1)
      : 0;
    const clpUsd = spent * clpBps / 10000;
    let net = proceeds - spent - wUsd - reb - clpUsd;

    // --- deriva esperada del precio durante la transferencia (informativo)
    const eta = (data.coins.find(c => c.sym === coin) || {}).eta || 5;
    const qb = q.binance;
    let driftBps = 0;
    if (qb && qb.hi > qb.lo && qb.lo > 0) {
      const rng = (qb.hi - qb.lo) / ((qb.hi + qb.lo) / 2);
      driftBps = (rng / 4) * Math.sqrt(eta / 1440) * 10000;
    }
    if (cfg.riskPenalty) net -= spent * driftBps / 10000;

    const netBps = net / spent * 10000;
    const grossBps = (bid / ask - 1) * 10000;
    const minSpreadBps = grossBps - netBps;      // spread bruto necesario para empatar

    const okUsd = net >= cfg.minNetUsd;
    const okBps = netBps >= cfg.minNetBps;
    const verdict = (okUsd && okBps) ? 'go' : (net > 0 ? 'thin' : 'no');

    return {
      coin, A, B, eta,
      ask, bid, buyPx, sellPx, spreadBps: grossBps,
      feeA, feeB, slipPct: slip * 100, slipMult,
      capUsd: spent, notional, qty, buyFeeUsd, sellFeeUsd,
      wCoins, wUsd, wUsdPata: wCoins * sellPx, batch, wChain: w.chain, wSrc: w.src, reb, rebVenue: B, rebChain: (fees.usdt[B] || {}).chain,
      netUsd: net, netBps, minSpreadBps, driftBps,
      costBps: minSpreadBps,
      cFeeA: feeA * 10000, cFeeB: feeB * 10000, cSlip: slip * 2 * 10000,
      cRed: spent ? wUsd / spent * 10000 : 0, cReb: spent ? reb / spent * 10000 : 0,
      cClp: clpBps, clpUsd, clpBatch: Math.max(1, Number(cfg.clpBatch) || 1),
      verdict, depthCap, limitedBy, slipMult, overBook,
      exhausted: cap >= (cfg.maxTradeUsd || Infinity) - 1e-9 && depthCap > cap,
      roiCommitmentBps: net / (cap * 2) * 10000,
      cyclesDia: Math.max(1, Math.floor(1440 / Math.max(eta, 1))),
      liquidezBuy: q[A].volUsd, liquidezSell: q[B].volUsd,
    };
  }

  // ------------------------------------------------------------ computeAll
  function computeAll(data, cfg) {
    const fees = resolveFees(data, cfg);
    const rows = [];
    const syms = (data.coins || []).map(c => c.sym);
    for (const coin of syms) {
      const q = data.quotes[coin];
      if (!q) continue;
      const vs = Object.keys(q).filter(v => fees.venueInfo[v] && !fees.venueInfo[v].off);
      for (const A of vs) for (const B of vs) {
        if (A === B) continue;
        const r = opportunity(coin, A, B, data, fees);
        if (r) rows.push(r);
      }
    }
    rows.sort((a, b) => b.netBps - a.netBps || b.netUsd - a.netUsd);

    // mejor por par de plataformas (para el mapa de calor)
    const pairs = {};
    for (const r of rows) {
      const k = r.A + '>' + r.B;
      if (!pairs[k] || r.netBps > pairs[k].netBps) pairs[k] = r;
    }

    const go = rows.filter(r => r.verdict === 'go');
    const thin = rows.filter(r => r.verdict === 'thin');
    const capital = (fees.venueInfo ? Object.keys(fees.venueInfo) : [])
      .filter(v => !fees.venueInfo[v].off)
      .reduce((s, v) => s + (Number(fees.cfg.balances[v]) || 0), 0);

    return { rows, pairs, go, thin, fees, capital, estimados: fees.estimados, ts: data.ts };
  }

  // ------------------------------------------------------------- simulador
  function simulate(row, ledger, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    const entry = {
      id: 'op-' + Date.now().toString(36),
      ts: Date.now(), coin: row.coin, buy: row.A, sell: row.B,
      usd: row.capUsd, net: row.netUsd, netBps: row.netBps,
      qty: row.qty, wCoins: row.wCoins, wChain: row.wChain, wUsd: row.wUsd,
      fees: row.buyFeeUsd + row.sellFeeUsd, reb: row.reb, eta: row.eta,
      buyPx: row.buyPx, sellPx: row.sellPx, spreadBps: row.spreadBps,
      verdict: row.verdict, wSrc: row.wSrc,
    };
    const bal = Object.assign({}, cfg.balances, (ledger && ledger.balances) || {});
    bal[row.A] = (Number(bal[row.A]) || 0) - row.capUsd;
    bal[row.B] = (Number(bal[row.B]) || 0) + row.capUsd + row.netUsd;
    return { entry, balances: bal };
  }

  function ledgerSummary(ledger, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    const ops = (ledger && ledger.ops) || [];
    const balances = Object.assign({}, cfg.balances, (ledger && ledger.balances) || {});
    const total = Object.values(cfg.balances || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const net = ops.reduce((s, o) => s + o.net, 0);
    const fees = ops.reduce((s, o) => s + (o.fees || 0), 0);
    const red = ops.reduce((s, o) => s + (o.wUsd || 0) + (o.reb || 0), 0);
    const volumen = ops.reduce((s, o) => s + o.usd, 0);
    const drift = Object.entries(balances)
      .map(([v, b]) => ({ venue: v, bal: Number(b) || 0, delta: (Number(b) || 0) - (Number(cfg.balances[v]) || 0) }))
      .sort((a, b) => b.delta - a.delta);
    const mejor = ops.slice().sort((a, b) => b.net - a.net)[0] || null;
    return {
      n: ops.length, net, fees, red, volumen, balances, capital: total,
      roiPct: total ? net / total * 100 : 0, ops, drift, mejor,
      porVenue: Object.keys(cfg.balances || {}).map(v => ({
        venue: v, bal: Number(balances[v]) || 0,
        ops: ops.filter(o => o.buy === v || o.sell === v).length,
      })),
    };
  }

  return {
    DEFAULTS, resolveFees, opportunity, computeAll, simulate, ledgerSummary,
    fmt: { num, usd, sgn, bps, pct, fmtTime, fmtDT, dur },
  };
});
