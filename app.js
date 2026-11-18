/* app.js — interfaz. Usa engine.js (window.Arb) y /api/market del colector local. */
(function () {
  'use strict';
  const E = window.Arb, F = E.fmt;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));
  const h = (v) => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const LS = { cfg: 'arb.cfg.v1', ledger: 'arb.ledger.v1', hist: 'arb.hist.v1' };
  const SERVER = 'http://127.0.0.1:8787';

  // ------------------------------------------------------------- estado
  const defCfg = () => Object.assign({}, E.DEFAULTS, { every: 5 });
  const state = {
    data: null, mode: 'snapshot', res: null, timer: null,
    cfg: read(LS.cfg, defCfg()),
    ledger: read(LS.ledger, { ops: [], balances: {} }),
    hist: read(LS.hist, []),
    feeCoin: null, sel: null, tab: 'ops',
  };
  function read(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v || d; } catch (e) { return d; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function saveCfg() { write(LS.cfg, state.cfg); }

  // ------------------------------------------------------ datos de mercado
  async function loadMarket() {
    for (const url of ['/api/market', SERVER + '/api/market']) {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (r.ok) { const d = await r.json(); if (d && d.quotes) return { data: d, mode: 'live' }; }
      } catch (e) { /* siguiente */ }
    }
    const el = document.getElementById('snapshot');
    if (el) { try { const d = JSON.parse(el.textContent); if (d && d.quotes) return { data: d, mode: 'snapshot' }; } catch (e) {} }
    return null;
  }

  async function refresh(manual) {
    const got = await loadMarket();
    if (!got) { setMode('bad', 'sin datos'); return; }
    state.data = got.data; state.mode = got.mode;
    if (!state.feeCoin) state.feeCoin = (got.data.coins[0] || {}).sym;
    compute();
    render();
    const pill = $('#modePill');
    if (got.mode === 'live') {
      const age = Date.now() - got.data.ts;
      const stale = age > Math.max(20000, state.cfg.every * 4000);
      setMode(stale ? 'snap' : 'live', stale ? 'datos de hace ' + Math.round(age / 1000) + ' s' : 'EN VIVO · API de las 4 plataformas');
    } else setMode('snap', 'instantánea guardada');
    $('#tsLabel').textContent = F.fmtTime(got.data.ts);
    $('#footTs').textContent = ' Última lectura: ' + F.fmtDT(got.data.ts) + (got.mode === 'live' ? '' : ' (instantánea)') + '.';
    if (manual) $('#refreshBtn').textContent = '↻ Actualizar';
  }

  function setMode(kind, txt) {
    const p = $('#modePill');
    p.className = 'pill ' + (kind === 'live' ? 'live' : kind === 'snap' ? 'snap' : 'bad');
    p.textContent = (kind === 'live' ? '● ' : '● ') + txt;
  }

  function effBalances() {
    const sim = state.ledger.ops && state.ledger.ops.length ? state.ledger.balances : null;
    return Object.assign({}, state.cfg.balances, sim || {});
  }

  function avisar(best) {
    if (!state.cfg.notify) return;
    const now = Date.now();
    if (state.lastAlert && now - state.lastAlert < 90000) return;
    state.lastAlert = now;
    const txt = best.coin + ' · ' + vname(best.A) + ' → ' + vname(best.B) + ' · neto ' + F.sgn(best.netUsd, 2) + ' (' + F.num(best.netBps, 1) + ' bps)';
    try {
      if (window.Notification && Notification.permission === 'granted') {
        new Notification('Arbitraje disponible', { body: txt });
      }
    } catch (e) {}
    try {
      const C = window.AudioContext || window.webkitAudioContext;
      if (C) {
        const ctx = new C();
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
        g.gain.value = 0.06; o.start();
        setTimeout(() => { o.stop(); ctx.close(); }, 260);
      }
    } catch (e) {}
    $('#simMsg').textContent = '🔔 ' + txt;
  }

  function compute() {
    state.res = E.computeAll(state.data, Object.assign({}, state.cfg, { balances: effBalances() }));
    const best = state.res.rows[0];
    if (state.res.go.length) avisar(state.res.go[0]); else state.lastAlert = 0;
    if (best) {
      state.hist.push({ ts: Date.now(), best: best.netBps, coin: best.coin, route: best.A + '>' + best.B });
      if (state.hist.length > (state.cfg.historyMax || 400)) state.hist = state.hist.slice(-400);
      write(LS.hist, state.hist);
    }
  }

  // ------------------------------------------------------------- helpers UI
  const vname = (id) => { const v = (state.data && state.data.venues || {})[id]; return v ? v.name : id; };
  const vpill = (id) => '<span class="venue"><i class="dot ' + h(id) + '"></i>' + h(vname(id)) + '</span>';
  const srcBadge = (s) => {
    const t = { live: 'live', declarado: 'declarado', 'declarado*': 'declarado', estimado: 'estimado', manual: 'tu valor', asumido: 'asumido' }[s] || s;
    const cls = (s === 'live') ? 'live' : (s === 'estimado' || s === 'declarado*') ? 'estimado' : s === 'asumido' ? 'asumido' : 'declarado';
    return '<span class="badge src ' + h(cls) + '">' + h(t) + '</span>';
  };
  const verdict = (r) => r.verdict === 'go' ? '<span class="badge go">RENTABLE</span>'
    : r.verdict === 'thin' ? '<span class="badge thin">MARGINAL</span>' : '<span class="badge no">NO</span>';
  const sgnCls = (v) => v > 0 ? 'g' : v < 0 ? 'r' : 'mut';
  const bpsTxt = (v) => F.num(v, 1) + ' bps';

  function ajustarUniverso() {
    const una = (state.data.coins || []).length <= 1;
    $('#fCoin').style.display = una ? 'none' : '';
    $('#feeCoinSel').style.display = una ? 'none' : '';
  }

  function populateVenueSelect() {
    const sel = $('#fVenue');
    if (sel.dataset.done) return;
    Object.keys(state.data.venues).forEach(v => {
      const o = document.createElement('option');
      o.value = v; o.textContent = 'Comprar en: ' + vname(v);
      sel.appendChild(o);
    });
    sel.dataset.done = '1';
  }

  // ------------------------------------------------------------- render
  function render() {
    if (!state.data || !state.res) return;
    populateVenueSelect();
    ajustarUniverso();
    renderBanners();
    renderKPIs();
    renderTable();
    renderVenueTable();
    renderHeat();
    renderChart();
    renderLedger();
    renderFees();
    renderSources();
    if (state.sel) {
      const r = state.res.rows.find(x => x.coin === state.sel.coin && x.A === state.sel.A && x.B === state.sel.B);
      if (r) state.sel = r;
      renderDrawer(state.sel);
    }
  }

  function renderBanners() {
    const res = state.res, b = [];
    if (state.mode === 'snapshot') {
      b.push('<div class="banner warn">⚠ No encontré el colector local, así que estoy mostrando una <b>instantánea guardada</b> del ' +
        F.fmtDT(state.data.ts) + '. Para precios en vivo abre una terminal y ejecuta <code>./start.sh</code> (o <code>python3 server.py</code>) y recarga esta página.</div>');
    }
    if ((state.data.errors || []).length) {
      b.push('<div class="banner warn">Avisos del colector: ' + state.data.errors.map(h).join(' · ') + '</div>');
    }
    if (res.estimados.length) {
      b.push('<div class="banner">ℹ ' + res.estimados.length + ' comisiones de retiro son <b>estimadas</b> (Bybit y OKX no publican API de comisiones). ' +
        'Puedes corregirlas en <b>Comisiones</b> y la página recalcula todo al instante.</div>');
    }
    if ((state.data.coins || []).length === 1 && res.rows.length) {
      const btc = res.rows[0];
      b.push('<div class="banner">₿ Universo BTC/USDT. La comisión de retiro de BTC es <b>fija</b> (' + F.num(btc.wCoins, 6) + ' BTC ≈ ' + F.usd(btc.wUsdPata, 2) + '): a 500 USDT pesa ' + F.num(btc.wUsdPata / 500 * 10000, 1) +
        ' bps, a 5.000 USDT pesa ' + F.num(btc.wUsdPata / 5000 * 10000, 1) + ' bps. Sube el tamaño, usa <b>rebalanceo por lotes</b> o Lightning para bajarla.</div>');
    }
    if (!res.go.length) {
      const cheap = res.rows.slice().sort((a, b2) => a.minSpreadBps - b2.minSpreadBps)[0];
      b.push('<div class="banner">🟡 Ahora mismo <b>ninguna</b> ruta deja margen después de comisiones (mercado eficiente). El ciclo más barato cuesta <b>' +
        (cheap ? F.num(cheap.minSpreadBps, 1) + ' bps en ' + cheap.coin + ' (' + vname(cheap.A) + '→' + vname(cheap.B) + ')' : '—') +
        '</b>. Cuando el spread bruto supere ese costo, la fila se marca <b>RENTABLE</b> y el KPI lo refleja al instante.</div>');
    }
    $('#banners').innerHTML = b.join('');
  }

  function renderKPIs() {
    const res = state.res, rows = res.rows;
    const best = rows[0] || null;
    const go = res.go;
    const cheap = rows.slice().sort((a, b) => a.minSpreadBps - b.minSpreadBps)[0] || null;
    const gapRow = rows.slice().sort((a, b) => b.spreadBps - a.spreadBps)[0] || null;
    const bals = Object.values(effBalances()).map(Number).filter(v => isFinite(v));
    const tramo = Math.min(state.cfg.maxTradeUsd || 0, bals.length ? Math.min.apply(null, bals) : 0);
    const c1 = !best ? 'bad' : best.netBps > 0 ? (best.verdict === 'go' ? 'good' : 'warn') : 'bad';
    const html = [
      card(c1, 'Mejor oportunidad', best ? F.sgn(best.netUsd, 2) : '—',
        best ? best.coin + ' · ' + vname(best.A) + ' → ' + vname(best.B) + ' · ' + bpsTxt(best.netBps) : 'sin datos'),
      card(go.length ? 'good' : 'warn', 'Rutas que pagan', go.length + ' de ' + rows.length,
        'umbral: ' + F.usd(state.cfg.minNetUsd, 2) + ' y ' + F.num(state.cfg.minNetBps, 0) + ' bps por ciclo'),
      card('', 'Ciclo más barato', cheap ? F.num(cheap.minSpreadBps, 1) + ' bps' : '—',
        cheap ? 'necesita ese spread bruto: ' + cheap.coin + ' ' + vname(cheap.A) + '→' + vname(cheap.B) : ''),
      card(gapRow && gapRow.spreadBps > gapRow.minSpreadBps ? 'good' : '', 'Mayor desajuste del momento',
        gapRow ? F.num(gapRow.spreadBps, 1) + ' bps' : '—',
        gapRow ? gapRow.coin + ' ' + vname(gapRow.A) + '→' + vname(gapRow.B) + ' · le faltan ' + F.num(Math.max(0, gapRow.minSpreadBps - gapRow.spreadBps), 1) + ' bps para pagar los costos' : ''),
      card('', 'Inventario y tramo', F.usd(res.capital, 0) + ' / ' + F.usd(tramo, 0),
        'monedas: ' + Object.keys(state.data.quotes).length + ' · comisiones estimadas: ' + res.estimados.length),
    ].join('');
    $('#kpis').innerHTML = html;
  }
  function card(cls, lab, val, sub) {
    return '<div class="kpi ' + cls + '"><div class="lab">' + h(lab) + '</div><div class="val num">' + h(val) + '</div><div class="sub">' + h(sub) + '</div></div>';
  }

  function visibleRows() {
    let rows = state.res.rows.slice();
    const q = ($('#fCoin').value || '').trim().toLowerCase();
    const v = $('#fVenue').value;
    if (q) rows = rows.filter(r => r.coin.toLowerCase().includes(q) || (vname(r.A) + vname(r.B)).toLowerCase().includes(q));
    if (v) rows = rows.filter(r => r.A === v);
    if ($('#fOnly').checked) rows = rows.filter(r => r.netUsd > 0);
    if ($('#fDecl').checked) rows = rows.filter(r => r.wSrc === 'live' || r.wSrc === 'manual' || r.wSrc === 'declarado' || r.wSrc === 'declarado*');
    if (state.cfg.includeClp) rows = rows.filter(r => r.verdict !== 'no' || r.netUsd > -9999);
    const s = $('#fSort').value;
    const cmp = {
      net: (a, b) => b.netUsd - a.netUsd, netbps: (a, b) => b.netBps - a.netBps,
      margin: (a, b) => (b.spreadBps - b.minSpreadBps) - (a.spreadBps - a.minSpreadBps),
      spread: (a, b) => b.spreadBps - a.spreadBps,
      liq: (a, b) => Math.min(b.liquidezBuy, b.liquidezSell) - Math.min(a.liquidezBuy, a.liquidezSell),
    }[s] || ((a, b) => b.netUsd - a.netUsd);
    return rows.sort(cmp);
  }

  function renderTable() {
    const rows = visibleRows();
    const limit = 70;
    const tb = $('#opsTable tbody');
    tb.innerHTML = rows.slice(0, limit).map((r, i) => {
      const cls = r.verdict === 'go' ? '' : r.verdict === 'thin' ? '' : 'dead';
      const sel = state.sel && state.sel.coin === r.coin && state.sel.A === r.A && state.sel.B === r.B ? ' sel' : '';
      return '<tr class="' + cls + sel + '" data-i="' + i + '">' +
        '<td><b>' + h(r.coin) + '</b> <span class="mut2" style="font-size:11px">' + h(F.dur(r.eta)) + '</span></td>' +
        '<td>' + vpill(r.A) + '<span class="arrow">→</span>' + vpill(r.B) + '</td>' +
        '<td class="right num">' + F.num(r.ask, r.ask < 1 ? 5 : 2) + '</td>' +
        '<td class="right num">' + F.num(r.bid, r.bid < 1 ? 5 : 2) + '</td>' +
        '<td class="right num ' + sgnCls(r.spreadBps) + '">' + bpsTxt(r.spreadBps) + '</td>' +
        '<td class="right num mut">−' + F.num(r.minSpreadBps, 1) + ' bps</td>' +
        '<td class="right num">' + F.usd(r.wUsd, 2) + ' <span class="mut2" style="font-size:11px">' + F.num(r.wCoins, r.wCoins < 1 ? 5 : 2) + ' ' + h(r.coin) + '</span> ' + srcBadge(r.wSrc) + '</td>' +
        '<td class="right num ' + sgnCls(r.netUsd) + '"><b>' + F.sgn(r.netUsd, 2) + '</b></td>' +
        '<td class="right num ' + sgnCls(r.netBps) + '">' + F.num(r.netBps, 1) + '</td>' +
        '<td class="right num mut">' + F.usd(r.capUsd, 0) + '</td>' +
        '<td>' + verdict(r) + '</td><td class="chev">›</td></tr>';
    }).join('');
    tb.querySelectorAll('tr').forEach(tr => tr.addEventListener('click', () => {
      openDrawer(rows[+tr.dataset.i]);
    }));
    $('#tableFoot').textContent = 'Mostrando ' + Math.min(limit, rows.length) + ' de ' + rows.length +
      ' rutas · precios top of book · ' + (state.mode === 'live' ? 'en vivo' : 'instantánea') +
      ' · el neto ya descuenta taker, slippage, comisión de red y rebalanceo.';
  }

  function renderVenueTable() {
    const q = state.data.quotes, venues = Object.keys(state.data.venues).filter(v => !(state.cfg.venuesOff || []).includes(v));
    const mids = {};
    venues.forEach(v => { const x = q[Object.keys(q)[0]]; if (x && x[v]) mids[v] = (x[v].bid + x[v].ask) / 2; });
    const lista = Object.keys(mids);
    const prom = lista.length ? lista.reduce((a, v) => a + mids[v], 0) / lista.length : 0;
    const fees = state.res.fees;
    $('#venueTable tbody').innerHTML = venues.map(v => {
      const x = (q[Object.keys(q)[0]] || {})[v];
      if (!x) return '<tr class="dead"><td>' + vpill(v) + '</td><td colspan="6" class="mut">sin par BTC/USDT</td></tr>';
      const interno = (x.bid / x.ask - 1) * 10000;
      const desvio = prom ? (mids[v] / prom - 1) * 10000 : 0;
      const w = (fees.wd[Object.keys(q)[0]] || {})[v] || {};
      const clase = desvio > 0.5 ? 'r' : desvio < -0.5 ? 'g' : 'mut';
      return '<tr>' +
        '<td>' + vpill(v) + '</td>' +
        '<td class="right num">' + F.num(x.bid, 2) + '</td>' +
        '<td class="right num">' + F.num(x.ask, 2) + '</td>' +
        '<td class="right num mut">' + F.num(interno, 1) + ' bps</td>' +
        '<td class="right num ' + clase + '"><b>' + F.num(desvio, 1) + ' bps</b></td>' +
        '<td class="right num mut">' + F.usd(x.volUsd, 0) + '</td>' +
        '<td class="right num">' + (w.fee == null ? '—' : F.num(w.fee, 6) + ' BTC · ' + F.usd(w.fee * x.ask, 2)) + ' ' + srcBadge(w.src || 'asumido') + '</td></tr>';
    }).join('');
    const caro = lista.sort((a, b) => mids[b] - mids[a]);
    if (caro.length > 1) {
      $('#venueFoot').innerHTML = 'Ahora mismo el BTC está más caro en <b>' + h(vname(caro[0])) + '</b> (' + F.num((mids[caro[0]] / prom - 1) * 10000, 1) + ' bps sobre el promedio) y más barato en <b>' + h(vname(caro[caro.length - 1])) + '</b> (' + F.num((mids[caro[caro.length - 1]] / prom - 1) * 10000, 1) + ' bps). Para arbitrar hay que comprar en la barata y vender en la cara: la diferencia entre esas dos puntas es el spread bruto de la tabla de arriba.';
    }
  }

  function renderHeat() {
    const venues = Object.keys(state.data.venues || {}).filter(v => !(state.cfg.venuesOff || []).includes(v));
    const pairs = state.res.pairs;
    let html = '<div class="hcell hhead"></div>' + venues.map(v => '<div class="hcell hhead">' + h(vname(v)) + '</div>').join('');
    for (const A of venues) {
      html += '<div class="hcell hlab">' + vpill(A) + '</div>';
      for (const B of venues) {
        if (A === B) { html += '<div class="hcell mut2">—</div>'; continue; }
        const r = pairs[A + '>' + B];
        const v = r ? r.netBps : null;
        const t = v === null ? -50 : v;
        const f = Math.max(-1, Math.min(1, t / 30));
        const bg = f >= 0 ? 'rgba(14,203,129,' + (0.10 + 0.5 * f) + ')' : 'rgba(246,70,93,' + (0.10 + 0.5 * -f) + ')';
        html += '<div class="hcell" style="background:' + bg + ';border-color:transparent;cursor:pointer" data-p="' + h(A + '>' + B) + '">' +
          '<b class="num">' + (v === null ? '—' : F.num(v, 0) + ' bps') + '</b><br><span style="font-size:11px" class="mut">' +
          (r ? h(r.coin) + ' · ' + F.sgn(r.netUsd, 2) : '') + '</span></div>';
      }
    }
    $('#heat').innerHTML = html;
    $('#heat').querySelectorAll('[data-p]').forEach(el => el.addEventListener('click', () => {
      const r = state.res.pairs[el.dataset.p]; if (r) openDrawer(r);
    }));
  }

  function renderChart() {
    const c = $('#chart'); if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 600, hgt = 170;
    c.width = w * dpr; c.height = hgt * dpr;
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const hist = state.hist.slice(-300);
    g.strokeStyle = '#2b3139'; g.beginPath(); g.moveTo(0, hgt / 2); g.lineTo(w, hgt / 2); g.stroke();
    if (hist.length < 2) { g.fillStyle = '#848e9c'; g.font = '12px system-ui'; g.fillText('Reuniendo datos…', 10, hgt / 2 - 8); return; }
    const vals = hist.map(p => p.best);
    const thr = state.cfg.minNetBps || 0;
    const max = Math.max.apply(null, vals.concat([thr + 5, 5])), min = Math.min.apply(null, vals.concat([-5, 0]));
    const X = (i) => i / (hist.length - 1) * (w - 8) + 4;
    const Y = (v) => hgt - 8 - (v - min) / (max - min) * (hgt - 16);
    // línea de umbral
    g.strokeStyle = 'rgba(252,213,53,.45)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, Y(thr)); g.lineTo(w, Y(thr)); g.stroke(); g.setLineDash([]);
    // serie
    g.strokeStyle = '#0ecb81'; g.lineWidth = 1.6; g.beginPath();
    vals.forEach((v, i) => { i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)); });
    g.stroke();
    g.fillStyle = '#848e9c'; g.font = '11px system-ui';
    g.fillText(F.num(max, 0) + ' bps', 4, 12);
    g.fillText(F.num(min, 0) + ' bps', 4, hgt - 2);
    g.fillText('umbral ' + F.num(thr, 0) + ' bps', w - 90, Y(thr) - 3);
    const last = hist[hist.length - 1];
    $('#chartFoot').innerHTML = 'Último: <b>' + h(last.coin) + '</b> ' + F.num(last.best, 1) + ' bps (' + h(vname(last.route.split('>')[0])) + '→' + h(vname(last.route.split('>')[1])) + ') · ' + hist.length + ' muestras.';
  }

  // ------------------------------------------------------------- simulador
  function renderLedger() {
    const s = E.ledgerSummary(state.ledger, Object.assign({}, state.cfg, { balances: state.cfg.balances }));
    $('#ledger tbody').innerHTML = s.ops.slice().reverse().slice(0, 60).map((o, i) => '<tr>' +
      '<td class="mut">' + (s.ops.length - i) + '</td><td class="num mut">' + h(F.fmtTime(o.ts)) + '</td>' +
      '<td>' + h(o.coin) + ' ' + vpill(o.buy) + '<span class="arrow">→</span>' + vpill(o.sell) + '</td>' +
      '<td class="right num">' + F.usd(o.usd, 0) + '</td>' +
      '<td class="right num">' + F.num(o.buyPx, o.buyPx < 1 ? 5 : 2) + '</td>' +
      '<td class="right num">' + F.num(o.sellPx, o.sellPx < 1 ? 5 : 2) + '</td>' +
      '<td class="right num">' + F.usd(o.fees, 2) + '</td>' +
      '<td class="right num">' + F.usd((o.wUsd || 0) + (o.reb || 0), 2) + '</td>' +
      '<td class="right num ' + sgnCls(o.net) + '"><b>' + F.sgn(o.net, 2) + '</b></td>' +
      '<td class="right num ' + sgnCls(o.netBps) + '">' + F.num(o.netBps, 1) + '</td></tr>').join('');
    const k = s.n ? [
      ['Operaciones', s.n, ''],
      ['Neto acumulado', F.sgn(s.net, 2), sgnCls(s.net)],
      ['Comisiones de trading', F.usd(s.fees, 2), 'mut'],
      ['Red + rebalanceo', F.usd(s.red, 2), 'mut'],
      ['Volumen movido', F.usd(s.volumen, 0), 'mut'],
      ['ROI sobre inventario', F.pct(s.roiPct, 3), sgnCls(s.roiPct)],
    ] : [['Operaciones', 0, ''], ['Neto acumulado', '$0.00', ''], ['Comisiones de trading', '$0.00', 'mut'], ['Red + rebalanceo', '$0.00', 'mut'], ['Volumen movido', '$0.00', 'mut'], ['ROI sobre inventario', '0.00%', '']];
    $('#simKpis').innerHTML = k.map(([l, v, c]) => '<div><div class="mut" style="font-size:11px">' + h(l) + '</div><div class="num ' + c + '" style="font-size:17px;font-weight:700">' + h(v) + '</div></div>').join('');
    $('#simBal').innerHTML = s.drift.map(d => '<span class="chip">' + h(vname(d.venue)) + ' <b class="num">' + F.usd(d.bal, 0) + '</b> <span class="' + sgnCls(d.delta) + '">' + (d.delta ? F.sgn(d.delta, 0) : '') + '</span></span>').join('') +
      (s.n ? '<span class="mut" style="font-size:12px">← así queda el inventario: para seguir operando hay que devolver USDT a la plataforma de compra (retiro barato tipo BSC/BEP20).</span>' : '');
  }

  function doSim(row) {
    if (!row) return;
    if (row.netUsd <= 0 && !confirm('Esta ruta pierde dinero (' + F.sgn(row.netUsd, 2) + '). ¿Simular igual?')) return;
    const out = E.simulate(row, state.ledger, state.cfg);
    state.ledger.ops.push(out.entry);
    state.ledger.balances = out.balances;
    write(LS.ledger, state.ledger);
    $('#simMsg').textContent = 'Simulado: ' + row.coin + ' ' + vname(row.A) + '→' + vname(row.B) + ' · neto ' + F.sgn(row.netUsd, 2);
    render();
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'sim'));
    $$('main > section').forEach(s => { s.hidden = s.id !== 'tab-sim'; });
    state.tab = 'sim';
  }

  // ------------------------------------------------------------- comisiones
  function renderFees() {
    const d = state.data, venues = Object.keys(d.venues);
    // tabla por plataforma
    $('#feeVenues tbody').innerHTML = venues.map(v => {
      const info = d.venues[v];
      const tk = state.cfg.takerOverride[v];
      return '<tr><td>' + vpill(v) + '</td>' +
        '<td class="right num">' + F.num(info.taker * 100, 3) + '%</td>' +
        '<td class="right num mut">' + (info.taker_bnb != null ? F.num(info.taker_bnb * 100, 3) + '%' : '—') + '</td>' +
        '<td class="right"><input type="number" step="0.001" min="0" style="width:90px" data-tk="' + h(v) + '" value="' + (tk == null ? '' : tk * 100) + '" placeholder="' + (info.taker * 100) + '"></td>' +
        '<td class="right num">' + F.usd((d.withdrawUsdt[v] || {}).fee, 2) + ' <span class="mut2">' + h((d.withdrawUsdt[v] || {}).chain || '') + '</span> ' + srcBadge((d.withdrawUsdt[v] || {}).src) + '</td>' +
        '<td class="mut" style="white-space:normal;font-size:12px">' + h(info.note || '') + '</td></tr>';
    }).join('');
    $('#feeVenues').querySelectorAll('[data-tk]').forEach(inp => inp.addEventListener('change', () => {
      const v = inp.dataset.tk, val = parseFloat(inp.value);
      if (isNaN(val)) delete state.cfg.takerOverride[v]; else state.cfg.takerOverride[v] = val / 100;
      saveCfg(); compute(); render();
    }));

    // selectores de moneda
    if ($('#feeCoinSel').options.length !== d.coins.length) {
      $('#feeCoinSel').innerHTML = d.coins.map(c => '<option value="' + h(c.sym) + '">' + h(c.sym) + ' · ' + h(c.name) + '</option>').join('');
      $('#feeCoinSel').value = state.feeCoin;
      $('#feeCoinSel').addEventListener('change', () => { state.feeCoin = $('#feeCoinSel').value; renderFees(); });
    }
    const coin = state.feeCoin, fees = state.res.fees;
    const ref = ((d.quotes[coin] || {}).binance || (d.quotes[coin] || {})[Object.keys(d.quotes[coin] || {})[0]] || {}).ask || 0;
    $('#feeCoins tbody').innerHTML = venues.map(v => {
      const e = (fees.wd[coin] || {})[v] || {};
      const usdFee = e.fee != null ? e.fee * ref : null;
      const ov = state.cfg.feeOverrides[v + '|' + coin];
      return '<tr><td>' + vpill(v) + '</td><td>' + h(e.chain || '—') + '</td>' +
        '<td class="right num">' + (e.fee == null ? '—' : F.num(e.fee, e.fee < 1 ? 6 : 2) + ' ' + h(coin)) + '</td>' +
        '<td class="right num">' + (usdFee == null ? '—' : F.usd(usdFee, 2)) + '</td>' +
        '<td class="right num">' + (usdFee == null ? '—' : F.num(usdFee / 5, 1) + ' bps a 500') + '</td>' +
        '<td>' + srcBadge(e.src || 'asumido') + '</td>' +
        '<td><input type="number" step="0.000001" min="0" style="width:120px" data-wd="' + h(v) + '|' + h(coin) + '" value="' + (ov && ov.fee != null ? ov.fee : '') + '" placeholder="' + (e.fee != null ? e.fee : '') + '"></td></tr>';
    }).join('');
    $('#feeCoins').querySelectorAll('[data-wd]').forEach(inp => inp.addEventListener('change', () => {
      const key = inp.dataset.wd, val = parseFloat(inp.value);
      if (isNaN(val)) delete state.cfg.feeOverrides[key]; else state.cfg.feeOverrides[key] = { fee: val };
      saveCfg(); compute(); render();
    }));
    $('#feeLinks').innerHTML = venues.map(v => '<a href="' + h(d.venues[v].url) + '" target="_blank" rel="noopener">' + h(d.venues[v].name) + '</a>').join(' · ') +
      ' · <a href="https://www.binance.com/en/fee/cryptoFee" target="_blank" rel="noopener">Binance retiros</a>' +
      ' · <a href="https://www.okx.com/fees/withdrawal" target="_blank" rel="noopener">OKX retiros</a>' +
      ' · <a href="https://www.bybit.com/en/help-center/article/Withdrawal-Fee-Schedule" target="_blank" rel="noopener">Bybit retiros</a>' +
      ' · <a href="https://www.bitget.com/fee/withdraw" target="_blank" rel="noopener">Bitget retiros</a>';
  }

  function renderSources() {
    const d = state.data;
    $('#srcTable tbody').innerHTML = (d.sources || []).map(s => '<tr><td><a href="' + h(s.url) + '" target="_blank" rel="noopener">' + h(s.name) + '</a></td><td class="mut">' + h(s.usado) + '</td></tr>').join('') +
      '<tr><td>Páginas oficiales de comisiones</td><td class="mut">taker de cada plataforma (oct 2026) y comisiones de retiro que no se pueden leer por API</td></tr>' +
      '<tr><td>Colector local</td><td class="mut">sin autenticación, sin API keys, sin acceso a tus cuentas</td></tr>';
    $('#ttlLab').textContent = d.priceTtl || 5;
  }

  // ------------------------------------------------------------- drawer
  function openDrawer(row) {
    state.sel = row; renderDrawer(row);
    $('#drawer').classList.add('open');
    const trs = $$('#opsTable tbody tr');
    requestAnimationFrame(() => { const i = visibleRows().findIndex(r => r.coin === row.coin && r.A === row.A && r.B === row.B); if (i >= 0 && trs[i]) trs[i].scrollIntoView({ block: 'nearest' }); });
  }
  function renderDrawer(r) {
    if (!r) return;
    const b = effBalances();
    const margen = r.spreadBps - r.minSpreadBps;
    const diario = r.netUsd * Math.min(r.cyclesDia, 8);
    const html =
      '<div class="row spread" style="margin-bottom:6px"><div>' + h(r.coin) + ' · ' + vpill(r.A) + '<span class="arrow">→</span>' + vpill(r.B) + '</div>' + verdict(r) + '</div>' +
      '<div class="kv"><span class="k">Precio de compra (ask ' + h(vname(r.A)) + ')</span><b class="num">' + F.num(r.ask, r.ask < 1 ? 6 : 2) + '</b></div>' +
      '<div class="kv"><span class="k">Precio de venta (bid ' + h(vname(r.B)) + ')</span><b class="num">' + F.num(r.bid, r.bid < 1 ? 6 : 2) + '</b></div>' +
      '<div class="kv"><span class="k">Spread bruto</span><b class="num ' + sgnCls(r.spreadBps) + '">' + bpsTxt(r.spreadBps) + '</b></div>' +
      '<div class="kv"><span class="k">Costo total del ciclo</span><b class="num mut">−' + F.num(r.minSpreadBps, 1) + ' bps</b></div>' +
      '<div class="kv"><span class="k">· Taker compra + venta</span><span class="num mut">' + F.num(r.cFeeA + r.cFeeB, 1) + ' bps</span></div>' +
      '<div class="kv"><span class="k">· Slippage ' + F.num(r.slipPct, 3) + '% por punta' + (r.slipMult > 1 ? ' (×' + F.num(r.slipMult, 1) + ': el tramo supera el primer nivel)' : '') + '</span><span class="num mut">' + F.num(r.cSlip, 1) + ' bps</span></div>' +
      '<div class="kv"><span class="k">· Comisión de red ' + h(r.coin) + ' (' + h(r.wChain) + (r.batch > 1 ? ', cada ' + r.batch + ' ciclos' : '') + ')</span><span class="num mut">' + F.num(r.cRed, 1) + ' bps · ' + F.usd(r.wUsd, 2) + (r.batch > 1 ? ' (de ' + F.usd(r.wUsdPata, 2) + ' por transferencia)' : '') + ' ' + srcBadge(r.wSrc) + '</span></div>' +
      '<div class="kv"><span class="k">· Retiro de USDT de vuelta (' + h(r.rebChain) + ')</span><span class="num mut">' + F.num(r.cReb, 1) + ' bps · ' + F.usd(r.reb, 2) + '</span></div>' +
      (r.cClp > 0 ? '<div class="kv"><span class="k">· Tramo CLP → USDT → CLP (cada ' + r.clpBatch + ' ciclos)</span><span class="num mut">' + F.num(r.cClp, 1) + ' bps · ' + F.usd(r.clpUsd, 2) + '</span></div>' : '') +
      '<hr style="border:0;border-top:1px solid #2b3139;margin:12px 0">' +
      '<div class="kv"><span class="k">Tamaño del tramo</span><b class="num">' + F.usd(r.capUsd, 0) + '</b></div>' +
      '<div class="kv"><span class="k">Monedas compradas / a vender</span><span class="num">' + F.num(r.qty, r.qty < 10 ? 4 : 2) + ' → ' + F.num(r.qty - r.wCoins, r.qty < 10 ? 4 : 2) + ' ' + h(r.coin) + '</span></div>' +
      '<div class="kv"><span class="k">Neto del ciclo</span><b class="num ' + sgnCls(r.netUsd) + '" style="font-size:16px">' + F.sgn(r.netUsd, 2) + ' (' + F.num(r.netBps, 1) + ' bps)</b></div>' +
      '<div class="kv"><span class="k">Si repites el ciclo cada ' + h(F.dur(r.eta)) + '</span><span class="num mut">≈ ' + F.sgn(diario, 2) + ' al día (tope 8 ciclos, sin deriva)</span></div>' +
      '<div class="kv"><span class="k">Margen sobre el costo</span><b class="num ' + sgnCls(margen) + '">' + F.num(margen, 1) + ' bps</b></div>' +
      '<div class="kv"><span class="k">Deriva esperada del precio (' + h(F.dur(r.eta)) + ')</span><span class="num ' + (r.driftBps > margen ? 'r' : 'mut') + '">±' + F.num(r.driftBps, 1) + ' bps' + (state.cfg.riskPenalty ? ' (restada)' : '') + '</span></div>' +
      '<div class="kv"><span class="k">Liquidez 24 h (compra / venta)</span><span class="num mut">' + F.usd(r.liquidezBuy, 0) + ' / ' + F.usd(r.liquidezSell, 0) + '</span></div>' +
      '<div class="kv"><span class="k">Inventario de moneda que exige el lote</span><span class="num mut">' + (r.batch > 1 ? F.usd(r.capUsd * r.batch, 0) + ' en ' + h(vname(r.B)) + ' (~' + r.batch + ' tramos)' : 'nada extra: transfieres en cada ciclo') + '</span></div>' +
      '<div class="kv"><span class="k">Primer nivel del libro (el más fino)</span><span class="num mut">' + (isFinite(r.depthCap) ? F.usd(r.depthCap, 0) + ' · el tramo es ' + F.num(r.capUsd / r.depthCap, 0) + '× ese nivel' : 'sin dato') + '</span></div>' +
      '<h3 style="font-size:13px;margin:16px 0 4px">Plan de ejecución</h3>' +
      '<ol class="steps">' +
      '<li>Ten el USDT listo en <b>' + h(vname(r.A)) + '</b> (lo fondeaste comprándolo con CLP por P2P/rampa: ese spread va aparte salvo que actives «Tramo CLP»).</li>' +
      '<li>Compra <b>' + F.num(r.qty, r.qty < 10 ? 4 : 2) + ' ' + h(r.coin) + '</b> a mercado en <b>' + h(vname(r.A)) + '</b> (gastas <b class="num">' + F.usd(r.capUsd, 2) + '</b>, comisión taker ' + F.num(r.feeA * 100, 3) + '%).</li>' +
      '<li>Retira por la red <b>' + h(r.wChain) + '</b> hacia <b>' + h(vname(r.B)) + '</b>: se descuentan <b class="num">' + F.num(r.wCoins, r.wCoins < 1 ? 5 : 2) + ' ' + h(r.coin) + '</b> (' + F.usd(r.wUsd, 2) + '). Tiempo típico ' + h(F.dur(r.eta)) + '. Verifica que ' + h(vname(r.B)) + ' acepte depósitos de ' + h(r.coin) + ' por esa red.</li>' +
      '<li>Vende a mercado en <b>' + h(vname(r.B)) + '</b>: recibes <b class="num">' + F.usd(r.capUsd + r.netUsd + r.reb, 2) + '</b> (comisión taker ' + F.num(r.feeB * 100, 3) + '%).</li>' +
      '<li>Devuelve USDT de <b>' + h(vname(r.B)) + '</b> a <b>' + h(vname(r.A)) + '</b> con red <b>' + h(r.rebChain) + '</b> (' + F.usd(r.reb, 2) + ') para poder repetir. Neto del ciclo: <b class="num ' + sgnCls(r.netUsd) + '">' + F.sgn(r.netUsd, 2) + '</b> USDT.</li>' +
      '<li>Cuando quieras volver a pesos, vende USDT por CLP (spread P2P de salida' + (r.clpBatch > 1 ? ', amortizado cada ' + r.clpBatch + ' ciclos' : '') + ').</li>' +
      '</ol>' +
      (r.wSrc === 'estimado' || r.wSrc === 'asumido' ? '<div class="note red">La comisión de red de ' + h(vname(r.A)) + ' para ' + h(r.coin) + ' es <b>estimada</b> (' + h(r.wSrc) + '): confírmala en la página de retiros antes de operar. Si es más alta, esta ruta puede dejar de ser rentable.</div>' : '') +
      (r.netUsd <= 0 ? '<div class="note">Con estos precios la ruta <b>no paga</b>: el spread bruto (' + bpsTxt(r.spreadBps) + ') no cubre el costo (' + F.num(r.minSpreadBps, 1) + ' bps). Necesitarías un spread bruto mayor a ' + F.num(r.minSpreadBps, 1) + ' bps.</div>'
        : '<div class="note green">Paga, pero recuerda: si el precio de ' + h(r.coin) + ' se mueve más de ' + F.num(r.driftBps, 1) + ' bps en los ' + h(F.dur(r.eta)) + ' de la transferencia, la ganancia desaparece.</div>') +
      '<div class="row" style="margin-top:14px"><button class="btn" id="dSim">▶ Simular esta operación</button>' +
      '<button class="btn ghost sm" id="dCopy">Copiar plan</button>' +
      '<span class="mut" style="font-size:11.5px">Inventario: ' + Object.keys(b).map(v => vname(v) + ' ' + F.usd(b[v], 0)).join(' · ') + '</span></div>';
    $('#dTitle').textContent = r.coin + ' · ' + F.sgn(r.netUsd, 2) + ' por ciclo';
    $('#dBody').innerHTML = html;
    $('#dSim').addEventListener('click', () => { doSim(r); $('#drawer').classList.remove('open'); });
    $('#dCopy').addEventListener('click', () => {
      const txt = [r.coin + ': comprar en ' + vname(r.A) + ' a ' + r.ask, 'retirar por ' + r.wChain + ' (comisión ' + r.wCoins + ' ' + r.coin + ') a ' + vname(r.B),
        'vender en ' + vname(r.B) + ' a ' + r.bid, 'tramo ' + r.capUsd.toFixed(2) + ' USDT, neto esperado ' + r.netUsd.toFixed(2) + ' USDT (' + r.netBps.toFixed(1) + ' bps)',
        'rebalancear USDT ' + vname(r.B) + '->' + vname(r.A) + ' por ' + r.rebChain].join('\n');
      navigator.clipboard && navigator.clipboard.writeText(txt);
      $('#dCopy').textContent = '¡Copiado!';
      setTimeout(() => { const el = $('#dCopy'); if (el) el.textContent = 'Copiar plan'; }, 1500);
    });
  }

  // ------------------------------------------------------------- config
  function openCfg() {
    const d = state.data, c = state.cfg;
    $('#cfgBal').innerHTML = Object.keys(d.venues).map(v =>
      '<div class="kv"><span class="k">' + h(d.venues[v].name) + '</span><input type="number" min="0" step="50" style="width:110px" data-bal="' + h(v) + '" value="' + (c.balances[v] == null ? 0 : c.balances[v]) + '"></div>').join('');
    $('#cfgMax').value = c.maxTradeUsd; $('#cfgSlip').value = c.slippagePct;
    $('#cfgMinUsd').value = c.minNetUsd; $('#cfgMinBps').value = c.minNetBps;
    $('#cfgEvery').value = c.every || 5; $('#cfgGen').value = c.genericWdPct;
    $('#cfgDepth').checked = !!c.useBookDepth; $('#cfgSlipOn').checked = !!c.slippageOn;
    $('#cfgReb').checked = !!c.includeRebalance; $('#cfgRisk').checked = !!c.riskPenalty;
    $('#cfgVenues').innerHTML = Object.keys(d.venues).map(v =>
      '<label class="chk"><input type="checkbox" data-ven="' + h(v) + '" ' + ((c.venuesOff || []).includes(v) ? '' : 'checked') + '> ' + h(d.venues[v].name) + '</label>' +
      (d.venues[v].taker_bnb != null ? '<label class="chk"><input type="checkbox" data-tok="' + h(v) + '" ' + (c.useTokenDiscount[v] ? 'checked' : '') + '> pagar fee con token</label>' : '')).join('');
    $('#cfgTaker').innerHTML = Object.keys(d.venues).map(v =>
      '<label class="chk">' + h(d.venues[v].name) + ' <input type="number" step="0.001" min="0" style="width:80px" data-tkin="' + h(v) + '" value="' + (c.takerOverride[v] == null ? '' : c.takerOverride[v] * 100) + '" placeholder="' + (d.venues[v].taker * 100) + '"> %</label>').join('');
    $('#cfgModal').classList.add('open');
  }
  function saveCfgFromModal() {
    const c = state.cfg;
    const chk = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
    const val = (id, def) => { const el = document.getElementById(id); const v = el ? parseFloat(el.value) : NaN; return isNaN(v) ? def : v; };
    $('#cfgBal').querySelectorAll('[data-bal]').forEach(i => c.balances[i.dataset.bal] = parseFloat(i.value) || 0);
    c.maxTradeUsd = val('cfgMax', 500);
    c.slippagePct = val('cfgSlip', 0);
    c.minNetUsd = val('cfgMinUsd', 0);
    c.minNetBps = val('cfgMinBps', 0);
    c.genericWdPct = val('cfgGen', 0);
    c.useBookDepth = chk('cfgDepth'); c.slippageOn = chk('cfgSlipOn');
    c.includeRebalance = chk('cfgReb'); c.riskPenalty = chk('cfgRisk');
    c.notify = chk('cfgNotify');
    c.includeClp = chk('cfgClp');
    c.clpBuyPct = val('cfgClpBuy', 0);
    c.clpSellPct = val('cfgClpSell', 0);
    c.clpBatch = Math.max(1, Math.round(val('cfgClpBatch', 1)));
    $('#fClp').checked = c.includeClp;
    if (c.notify && window.Notification && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) {} }
    c.venuesOff = $$('#cfgVenues [data-ven]').filter(i => !i.checked).map(i => i.dataset.ven);
    $$('#cfgVenues [data-tok]').forEach(i => c.useTokenDiscount[i.dataset.tok] = i.checked);
    $$('#cfgTaker [data-tkin]').forEach(i => { const v = parseFloat(i.value); if (isNaN(v)) delete c.takerOverride[i.dataset.tkin]; else c.takerOverride[i.dataset.tkin] = v / 100; });
    c.every = Math.max(3, Math.round(val('cfgEvery', 5)));
    saveCfg();
    $('#fSize').value = Math.min(5000, Math.max(100, c.maxTradeUsd));
    $('#sizeLab').textContent = F.num(c.maxTradeUsd, 0);
    $('#cfgModal').classList.remove('open');
    compute(); render(); restartTimer();
  }

  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
  }

  function restartTimer() {
    clearInterval(state.timer);
    state.timer = setInterval(() => refresh(false), Math.max(3, state.cfg.every || 5) * 1000);
  }

  // ------------------------------------------------------------- eventos
  function bind() {
    $$('.tab').forEach(t => t.addEventListener('click', () => {
      state.tab = t.dataset.tab;
      $$('.tab').forEach(x => x.classList.toggle('active', x === t));
      $$('main > section').forEach(s => { s.hidden = s.id !== 'tab-' + state.tab; });
      try { history.replaceState(null, '', '#' + state.tab); } catch (e) {}
      if (state.tab === 'ops') renderChart();
    }));
    $('#refreshBtn').addEventListener('click', () => { $('#refreshBtn').textContent = '…'; refresh(true); });
    $('#cfgBtn').addEventListener('click', openCfg);
    $('#cfgClose').addEventListener('click', () => $('#cfgModal').classList.remove('open'));
    $('#cfgSave').addEventListener('click', saveCfgFromModal);
    $('#cfgReset').addEventListener('click', () => {
      if (!confirm('¿Borrar configuración, simulación e historial?')) return;
      [LS.cfg, LS.ledger, LS.hist].forEach(k => localStorage.removeItem(k));
      state.cfg = defCfg(); state.ledger = { ops: [], balances: {} }; state.hist = [];
      $('#cfgModal').classList.remove('open'); compute(); render(); restartTimer();
    });
    $('#cfgExport').addEventListener('click', () => download('arbitraje-config.json', { cfg: state.cfg, ledger: state.ledger }));
    $('#cfgImport').addEventListener('click', () => {
      const t = prompt('Pega el JSON exportado:');
      if (!t) return;
      try { const o = JSON.parse(t); if (o.cfg) state.cfg = Object.assign(defCfg(), o.cfg); if (o.ledger) state.ledger = o.ledger; saveCfg(); write(LS.ledger, state.ledger); compute(); render(); alert('Listo.'); }
      catch (e) { alert('JSON inválido'); }
    });
    $('#dClose').addEventListener('click', () => { $('#drawer').classList.remove('open'); state.sel = null; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#drawer').classList.remove('open'); $('#cfgModal').classList.remove('open'); } });
    ['fCoin', 'fVenue', 'fSort', 'fOnly', 'fDecl', 'fClp'].forEach(id => {
      const el = $('#' + id);
      const fn = () => { if (id === 'fClp') { state.cfg.includeClp = el.checked; saveCfg(); compute(); render(); } else renderTable(); };
      el.addEventListener('input', fn); el.addEventListener('change', fn);
    });
    $('#fBatch').addEventListener('change', () => {
      state.cfg.rebalanceBatch = parseInt($('#fBatch').value, 10) || 1;
      saveCfg(); compute(); render();
    });
    $('#fSize').addEventListener('input', () => {
      const v = parseFloat($('#fSize').value);
      state.cfg.maxTradeUsd = v; $('#sizeLab').textContent = F.num(v, 0); saveCfg(); render();
      const minBal = Math.min.apply(null, Object.values(state.cfg.balances).map(Number));
      $('#sizeLab').title = v > minBal ? 'limitado por el inventario: la plataforma con menos saldo tiene ' + F.usd(minBal, 0) : '';
    });
    $('#simBest').addEventListener('click', () => doSim(visibleRows()[0]));
    $('#simWorst').addEventListener('click', () => { const r = visibleRows(); doSim(r[r.length - 1]); });
    $('#simReset').addEventListener('click', () => {
      state.ledger = { ops: [], balances: {} };
      write(LS.ledger, state.ledger);
      state.cfg.balances = Object.assign({}, defCfg().balances);
      saveCfg(); compute(); render();
    });
  }

  // ------------------------------------------------------------- arranque
  function bootSnapshot() {
    const el = document.getElementById('snapshot');
    if (!el) return false;
    try {
      const d = JSON.parse(el.textContent);
      if (!d || !d.quotes) return false;
      state.data = d; state.mode = 'snapshot';
      state.feeCoin = (d.coins[0] || {}).sym;
      compute(); render();
      setMode('snap', 'instantánea local · buscando precios en vivo…');
      $('#tsLabel').textContent = F.fmtTime(d.ts);
      return true;
    } catch (e) { return false; }
  }

  bind();
  $('#fBatch').value = String(state.cfg.rebalanceBatch || 1);
  $('#fSize').value = Math.min(5000, Math.max(100, state.cfg.maxTradeUsd || 500));
  $('#sizeLab').textContent = F.num(state.cfg.maxTradeUsd || 500, 0);
  bootSnapshot();
  refresh(true);
  restartTimer();
  const inicial = (location.hash || '').replace('#', '');
  if (['ops', 'map', 'sim', 'fees', 'help'].indexOf(inicial) > 0) {
    const t = document.querySelector('.tab[data-tab="' + inicial + '"]');
    if (t) t.click();
  }
})();
