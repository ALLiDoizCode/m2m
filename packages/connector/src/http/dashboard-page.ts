/**
 * Operator dashboard — a single self-contained HTML page served by the admin API
 * at GET /admin/dashboard.
 *
 * @remarks
 * Zero build step, zero external dependencies, no CDN: the page is embedded as a
 * string constant so it compiles into `dist/` with the rest of the connector and
 * ships with the node. It polls the connector's OWN admin endpoints, same-origin:
 *   - GET /admin/metrics.json  (1 Hz)   throughput / rejects / bytes / per-peer
 *   - GET /admin/earnings.json (0.2 Hz) fees (estimated) / per-asset volume / claims
 *   - GET /health              (once/tick) admin-server liveness for the status pill
 *
 * Because it is mounted INSIDE the admin router, it inherits the admin IP
 * allowlist / API-key auth. When an API key is configured, the page prompts for
 * it and sends it as the `X-Api-Key` header (never as a query param — the admin
 * API rejects keys in the query string).
 *
 * Honesty labels baked into the UI (do not remove without fixing the underlying
 * data): connector fees are an APPROXIMATION (incomingVolume * feePct; a dedicated
 * fee ledger is a follow-up); the throughput sparkline is SESSION-LOCAL (built from
 * polls since page load — there is no historical series endpoint yet); the reject
 * tile shows the AGGREGATE count only (the per-reason breakdown lives in the
 * Prometheus /metrics endpoint, not in metrics.json).
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TOON connector — operator dashboard</title>
<style>
  :root {
    --bg:#0d1117; --panel:#161b22; --border:#30363d; --fg:#e6edf3; --muted:#8b949e;
    --accent:#2f81f7; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --grid:#21262d;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f8fa; --panel:#fff; --border:#d0d7de; --fg:#1f2328; --muted:#59636e;
            --accent:#0969da; --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e; --grid:#eaeef2; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  header { display:flex; align-items:center; gap:12px; padding:14px 20px;
           border-bottom:1px solid var(--border); flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:.2px; }
  .pill { font-size:12px; padding:2px 9px; border-radius:999px; border:1px solid var(--border);
          color:var(--muted); display:inline-flex; align-items:center; gap:6px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); }
  .dot.ok{background:var(--ok);} .dot.bad{background:var(--bad);} .dot.warn{background:var(--warn);}
  .spacer { flex:1; }
  main { padding:20px; display:grid; gap:16px;
         grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); max-width:1200px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px; }
  .card h2 { font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:var(--muted);
             margin:0 0 12px; font-weight:600; }
  .big { font-size:30px; font-weight:650; font-variant-numeric:tabular-nums; }
  .sub { color:var(--muted); font-size:12px; margin-top:2px; }
  .row { display:flex; justify-content:space-between; gap:10px; padding:4px 0;
         font-variant-numeric:tabular-nums; }
  .row .k { color:var(--muted); }
  .grid2 { grid-column:1/-1; }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th,td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--grid); font-size:13px; }
  th { color:var(--muted); font-weight:500; font-size:11px; text-transform:uppercase; letter-spacing:.4px; }
  td.n, th.n { text-align:right; }
  .muted { color:var(--muted); }
  .est { font-size:11px; color:var(--warn); }
  svg { width:100%; height:56px; display:block; }
  .banner { margin:16px 20px 0; padding:12px 14px; border:1px solid var(--warn); border-radius:8px;
            background:rgba(210,153,34,.08); color:var(--fg); font-size:13px; display:none; }
  .banner.show { display:block; }
  .banner input { margin-left:8px; padding:5px 8px; background:var(--bg); color:var(--fg);
                  border:1px solid var(--border); border-radius:6px; }
  .banner button { margin-left:8px; padding:5px 12px; background:var(--accent); color:#fff;
                   border:0; border-radius:6px; cursor:pointer; }
  footer { padding:14px 20px; color:var(--muted); font-size:12px; border-top:1px solid var(--border);
           margin-top:8px; }
  code { background:var(--grid); padding:1px 5px; border-radius:4px; }
</style>
</head>
<body>
<header>
  <h1>TOON connector — operator dashboard</h1>
  <span class="pill" id="node"><span class="dot" id="nodeDot"></span><span id="nodeId">g.proxy</span></span>
  <span class="pill" id="uptime">uptime —</span>
  <div class="spacer"></div>
  <span class="pill" id="status"><span class="dot" id="statusDot"></span><span id="statusText">connecting…</span></span>
</header>

<div class="banner" id="auth">
  This admin API needs a key.
  <input id="apiKey" type="password" placeholder="X-Api-Key" autocomplete="off" />
  <button id="applyKey">Connect</button>
</div>

<main>
  <div class="card">
    <h2>Throughput</h2>
    <div class="big" id="fwdRate">0<span style="font-size:14px;" class="muted"> /s</span></div>
    <div class="sub">packets forwarded &middot; <span id="rejRate">0</span>/s rejected</div>
    <svg id="spark" viewBox="0 0 100 56" preserveAspectRatio="none" aria-hidden="true"></svg>
    <div class="sub">session-local (since page load)</div>
  </div>

  <div class="card">
    <h2>Totals</h2>
    <div class="row"><span class="k">Forwarded</span><span id="tFwd">0</span></div>
    <div class="row"><span class="k">Locally delivered</span><span id="tLocal">0</span></div>
    <div class="row"><span class="k">Rejected</span><span id="tRej">0</span></div>
    <div class="row"><span class="k">Reject rate</span><span id="rejPct">0%</span></div>
    <div class="row"><span class="k">Bytes sent</span><span id="tBytes">0</span></div>
    <div class="sub">per-reason reject breakdown: Prometheus <code>/metrics</code></div>
  </div>

  <div class="card">
    <h2>Peers</h2>
    <div class="big" id="peerCount">0</div>
    <div class="sub"><span id="peerConn">0</span> connected</div>
    <div class="row" style="margin-top:10px;"><span class="k">Discovered</span><span id="disc">—</span></div>
    <div class="row"><span class="k">Funded</span><span id="funded">—</span></div>
  </div>

  <div class="card">
    <h2>Earnings <span class="est">estimated</span></h2>
    <div id="fees"><div class="muted">no fees yet</div></div>
    <div class="sub">connector fee = inbound volume &times; fee&nbsp;% (approximate; no fee ledger yet)</div>
  </div>

  <div class="card grid2">
    <h2>Per-peer activity</h2>
    <table>
      <thead><tr><th>Peer</th><th>State</th><th class="n">Fwd</th><th class="n">Rej</th>
        <th class="n">Bytes</th><th>Last packet</th></tr></thead>
      <tbody id="peerRows"><tr><td colspan="6" class="muted">waiting for data…</td></tr></tbody>
    </table>
  </div>

  <div class="card grid2">
    <h2>Recent claims</h2>
    <table>
      <thead><tr><th>When</th><th>Peer</th><th>Dir</th><th class="n">Amount</th><th>Asset</th></tr></thead>
      <tbody id="claimRows"><tr><td colspan="5" class="muted">none yet</td></tr></tbody>
    </table>
  </div>
</main>

<footer>
  Served by the connector admin API &middot; metrics poll 1&nbsp;Hz, earnings 0.2&nbsp;Hz &middot;
  fees are estimated and today/month/year deltas are not yet computed.
</footer>

<script>
(function () {
  var KEYSTORE = 'toon_admin_key';
  var apiKey = null;
  try { apiKey = localStorage.getItem(KEYSTORE); } catch (e) {}

  var spark = [];       // session-local forwarded/s samples
  var SPARK_MAX = 60;
  var prev = null;      // previous metrics snapshot for rate calc

  function el(id) { return document.getElementById(id); }
  function setPill(dotId, textId, cls, text) {
    var d = el(dotId); d.className = 'dot ' + cls;
    if (textId) el(textId).textContent = text;
  }
  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'G';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function fmtAmount(raw, scale) {
    // raw is an integer string in base units; scale is decimal places.
    var s = String(raw || '0');
    if (!scale) return s;
    var neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
    while (s.length <= scale) s = '0' + s;
    var whole = s.slice(0, s.length - scale);
    var frac = s.slice(s.length - scale).replace(/0+$/, '');
    return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
  }
  function ago(iso) {
    if (!iso) return '—';
    var t = Date.parse(iso); if (isNaN(t)) return '—';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  }
  function uptimeStr(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var d = Math.floor(sec / 86400); sec -= d * 86400;
    var h = Math.floor(sec / 3600); sec -= h * 3600;
    var m = Math.floor(sec / 60);
    if (d) return 'uptime ' + d + 'd ' + h + 'h';
    if (h) return 'uptime ' + h + 'h ' + m + 'm';
    return 'uptime ' + m + 'm';
  }

  function apiFetch(path) {
    var opts = { headers: {}, cache: 'no-store' };
    if (apiKey) opts.headers['X-Api-Key'] = apiKey;
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { showAuth(true); var e = new Error('unauthorized'); e.code = 401; throw e; }
      if (r.status === 403) { var e2 = new Error('forbidden'); e2.code = 403; throw e2; }
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  function showAuth(show) { el('auth').className = show ? 'banner show' : 'banner'; }
  el('applyKey').addEventListener('click', function () {
    apiKey = el('apiKey').value || null;
    try { if (apiKey) localStorage.setItem(KEYSTORE, apiKey); } catch (e) {}
    showAuth(false); tick();
  });

  function drawSpark() {
    var svg = el('spark');
    if (!spark.length) { svg.innerHTML = ''; return; }
    var max = Math.max.apply(null, spark); if (max <= 0) max = 1;
    var n = spark.length, step = 100 / Math.max(1, SPARK_MAX - 1);
    var pts = spark.map(function (v, i) {
      var x = i * step, y = 56 - (v / max) * 52 - 2;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    svg.innerHTML =
      '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="1.6" ' +
      'vector-effect="non-scaling-stroke" stroke-linejoin="round" />';
  }

  function renderMetrics(m) {
    var a = m.aggregate || {};
    el('tFwd').textContent = fmt(a.packetsForwarded);
    el('tLocal').textContent = fmt(a.packetsLocallyDelivered);
    el('tRej').textContent = fmt(a.packetsRejected);
    el('tBytes').textContent = fmt(a.bytesSent) + 'B';
    var tot = (a.packetsForwarded || 0) + (a.packetsRejected || 0);
    el('rejPct').textContent = tot ? ((a.packetsRejected / tot) * 100).toFixed(1) + '%' : '0%';
    el('uptime').textContent = uptimeStr(m.uptimeSeconds);

    var peers = m.peers || [];
    el('peerCount').textContent = String(peers.length);
    el('peerConn').textContent = String(peers.filter(function (p) { return p.connected; }).length);

    // rate from delta since previous poll
    if (prev) {
      var dt = (Date.parse(m.timestamp) - Date.parse(prev.timestamp)) / 1000;
      if (dt > 0) {
        var fwd = Math.max(0, (a.packetsForwarded - (prev.aggregate.packetsForwarded || 0)) / dt);
        var rej = Math.max(0, (a.packetsRejected - (prev.aggregate.packetsRejected || 0)) / dt);
        el('fwdRate').innerHTML = fwd.toFixed(fwd < 10 ? 1 : 0) +
          '<span style="font-size:14px;" class="muted"> /s</span>';
        el('rejRate').textContent = rej.toFixed(rej < 10 ? 1 : 0);
        spark.push(fwd); if (spark.length > SPARK_MAX) spark.shift();
        drawSpark();
      }
    }
    prev = m;

    var rows = peers.map(function (p) {
      var cls = p.connected ? 'ok' : 'bad';
      return '<tr><td>' + escapeHtml(p.peerId) + '</td>' +
        '<td><span class="dot ' + cls + '" style="display:inline-block;margin-right:6px;"></span>' +
        (p.connected ? 'up' : 'down') + '</td>' +
        '<td class="n">' + fmt(p.packetsForwarded) + '</td>' +
        '<td class="n">' + fmt(p.packetsRejected) + '</td>' +
        '<td class="n">' + fmt(p.bytesSent) + '</td>' +
        '<td class="muted">' + ago(p.lastPacketAt) + '</td></tr>';
    });
    el('peerRows').innerHTML = rows.length ? rows.join('') :
      '<tr><td colspan="6" class="muted">no peers</td></tr>';
  }

  function renderEarnings(e) {
    var fees = e.connectorFees || [];
    el('fees').innerHTML = fees.length ? fees.map(function (f) {
      return '<div class="row"><span class="k">' + escapeHtml(f.assetCode) + '</span><span>' +
        fmtAmount(f.total, f.assetScale) + '</span></div>';
    }).join('') : '<div class="muted">no fees yet</div>';

    var claims = e.recentClaims || [];
    el('claimRows').innerHTML = claims.length ? claims.slice(0, 20).map(function (c) {
      return '<tr><td class="muted">' + ago(c.at) + '</td><td>' + escapeHtml(c.peerId) + '</td>' +
        '<td>' + c.direction + '</td>' +
        '<td class="n">' + fmtAmount(c.amount, c.assetScale) + '</td>' +
        '<td>' + escapeHtml(c.assetCode) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="muted">none yet</td></tr>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var earnEvery = 5, sinceEarn = 99, sinceDisc = 99;

  function tick() {
    apiFetch('./metrics.json').then(function (m) {
      setPill('statusDot', 'statusText', 'ok', 'live');
      setPill('nodeDot', null, 'ok');
      renderMetrics(m);
    }).catch(function (err) {
      if (err.code === 401) { setPill('statusDot', 'statusText', 'warn', 'auth required'); return; }
      setPill('statusDot', 'statusText', 'bad', 'unreachable');
      setPill('nodeDot', null, 'bad');
    });

    if (++sinceEarn >= earnEvery) {
      sinceEarn = 0;
      apiFetch('./earnings.json').then(renderEarnings).catch(function () {});
    }
    if (++sinceDisc >= earnEvery) {
      sinceDisc = 0;
      apiFetch('./discovered-nodes').then(function (d) {
        var nodes = (d && d.nodes) || d || [];
        var total = Array.isArray(nodes) ? nodes.length : (d.count || 0);
        var fundedN = Array.isArray(nodes) ? nodes.filter(function (n) { return n.funded; }).length : (d.funded || 0);
        el('disc').textContent = String(total);
        el('funded').textContent = String(fundedN);
      }).catch(function () {});
    }
  }

  tick();
  setInterval(tick, 1000);
})();
</script>
</body>
</html>`;
