/* test-engine.js — validaciones del motor de cálculo.
 * Uso: node test-engine.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Arb = require('./engine.js');

let fallos = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FALLA') + '  ' + msg); if (!cond) fallos++; };
const cerca = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '  (' + a.toFixed(6) + ' ≈ ' + b.toFixed(6) + ')');

// ---------------------------------------------------------- 1) caso exacto
const base = Object.assign({}, Arb.DEFAULTS, {
  balances: { binance: 500, bybit: 500 }, maxTradeUsd: 500, slippageOn: false,
  includeRebalance: false, useBookDepth: false,
});
const fixture = {
  ts: Date.now(), priceTtl: 5,
  venues: { binance: { name: 'Binance', taker: 0.001 }, bybit: { name: 'Bybit', taker: 0.001 } },
  coins: [{ sym: 'XRP', name: 'XRP', eta: 1, risk: 'bajo' }],
  quotes: {
    XRP: {
      binance: { bid: 0.999, ask: 1.0, bidSz: 1e6, askSz: 1e6, volUsd: 1e7 },
      bybit: { bid: 1.05, ask: 1.0501, bidSz: 1e6, askSz: 1e6, volUsd: 1e7 },
    },
  },
  withdraw: { binance: { XRP: { fee: 0.2, chain: 'XRP', src: 'live' } } },
  withdrawUsdt: { bybit: { fee: 0.5, chain: 'BEP20', src: 'estimado' } },
  sources: [], errors: [],
};

console.log('1) ruta rentable construida a mano (ask 1,00 → bid 1,05; red 0,2 XRP):');
const res = Arb.computeAll(fixture, base);
const r = res.rows.find(x => x.coin === 'XRP' && x.A === 'binance' && x.B === 'bybit');
const notional = 500 / 1.001;
const esperado = notional * 1.05 * 0.999 - 500 - 0.2 * 1.05;
cerca(r.capUsd, 500, 1e-9, 'tamaño = 500 USDT');
cerca(r.qty, notional, 1e-9, 'cantidad = 500 / (1 + taker) / ask');
cerca(r.netUsd, esperado, 1e-6, 'neto = bid×(1−taker)×cantidad − USDT − red (red valorizada al bid)');
cerca(r.netBps, esperado / 500 * 10000, 1e-6, 'neto en bps sobre el tramo');
ok(r.verdict === 'go', 'veredicto RENTABLE con este spread (≈500 bps)');
ok(r.spreadBps > 500 && r.minSpreadBps < 40, 'spread bruto ≈500 bps y costo del ciclo <40 bps');

console.log('2) el mismo caso con slippage 0,05 % por punta:');
const conSlip = Arb.computeAll(fixture, Object.assign({}, base, { slippageOn: true, slippagePct: 0.05 }));
const r2 = conSlip.rows.find(x => x.coin === 'XRP' && x.A === 'binance');
ok(r2.netUsd < r.netUsd, 'el slippage baja el neto (' + r2.netUsd.toFixed(2) + ' < ' + r.netUsd.toFixed(2) + ')');
cerca(r.spreadBps - r2.minSpreadBps, r2.netBps, 1e-6, 'neto bps = spread bruto − costo del ciclo');

console.log('3) sin margen: el mismo par al revés (comprar 1,0501 y vender 0,999):');
const r3 = res.rows.find(x => x.coin === 'XRP' && x.A === 'bybit');
ok(r3 && r3.netUsd < 0 && r3.verdict === 'no', 'neto negativo y veredicto NO');

console.log('4) rebalanceo incluido:');
const reb = Arb.computeAll(fixture, Object.assign({}, base, { includeRebalance: true }));
const r4 = reb.rows.find(x => x.coin === 'XRP' && x.A === 'binance');
ok(r4.reb === 0.5 && cerca2(r4.netUsd, (r.netUsd - 0.5), 1e-9), 'resta el retiro de USDT de la punta de venta');
function cerca2(a, b, tol) { return Math.abs(a - b) <= tol; }

console.log('5) simulador y resumen:');
const sim = Arb.simulate(r, { ops: [], balances: {} }, base);
cerca(sim.balances.binance, 0, 1e-9, 'queda sin USDT en la plataforma de compra');
cerca(sim.balances.bybit, 1000 + r.netUsd, 1e-9, 'la punta de venta recibe tramo + neto');
const sum = Arb.ledgerSummary({ ops: [sim.entry], balances: sim.balances }, base);
cerca(sum.net, r.netUsd, 1e-9, 'P&L acumulado = neto de la operación');
cerca(sum.capital, 1000, 1e-9, 'capital declarado = 1000');
ok(sum.drift.find(d => d.venue === 'bybit').delta > 0, 'detecta el descuadre de inventario a rebalancear');

console.log('6) tramo CLP (comprar USDT con CLP y volver a CLP):');
const clp = Arb.computeAll(fixture, Object.assign({}, base, { includeClp: true, clpBuyPct: 0.5, clpSellPct: 0.5, clpBatch: 1 }));
const r5 = clp.rows.find(x => x.coin === 'XRP' && x.A === 'binance');
cerca(r5.clpUsd, 500 * 0.01, 1e-9, 'costo CLP = 1% del tramo (0,5% + 0,5%)');
cerca(r5.netUsd, r.netUsd - 5, 1e-9, 'resta 5 USDT al neto del ciclo');
const clp10 = Arb.computeAll(fixture, Object.assign({}, base, { includeClp: true, clpBuyPct: 0.5, clpSellPct: 0.5, clpBatch: 10 }));
const r6 = clp10.rows.find(x => x.coin === 'XRP' && x.A === 'binance');
cerca(r6.clpUsd, 0.5, 1e-9, 'amortizado cada 10 ciclos = 0,5 USDT por ciclo');

console.log('7) instantánea real (si existe snapshot.json):');
const snapPath = path.join(__dirname, 'snapshot.json');
if (fs.existsSync(snapPath)) {
  const data = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  const real = Arb.computeAll(data, Object.assign({}, Arb.DEFAULTS, { every: 5 }));
  ok(real.rows.length >= 6, 'rutas calculadas: ' + real.rows.length);
  ok(Object.keys(data.quotes).length >= 1, 'monedas con mercado en 2+ plataformas: ' + Object.keys(data.quotes).length + ' (' + Object.keys(data.quotes).join(',') + ')');
  const malo = real.rows.find(x => !isFinite(x.netUsd) || !isFinite(x.netBps) || x.minSpreadBps <= 0);
  ok(!malo, 'todas las rutas tienen números finitos y costo > 0');
  const coherencia = real.rows.every(x => Math.abs((x.spreadBps - x.minSpreadBps) - x.netBps) < 1e-6);
  ok(coherencia, 'coherencia: neto bps = spread bruto − costo del ciclo, en todas las rutas');
  console.log('     mejor ruta ahora: ' + real.rows[0].coin + ' ' + real.rows[0].A + '→' + real.rows[0].B +
    '  spread ' + real.rows[0].spreadBps.toFixed(1) + ' bps, costo ' + real.rows[0].minSpreadBps.toFixed(1) +
    ' bps, neto ' + real.rows[0].netUsd.toFixed(2) + ' USDT (' + real.go.length + ' rutas RENTABLES)');
} else {
  console.log('  (sin snapshot.json, se omite)');
}

console.log(fallos ? '\n' + fallos + ' fallas' : '\nTodo bien: ' + 0 + ' fallas');
process.exit(fallos ? 1 : 0);
