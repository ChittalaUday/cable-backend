/** Shared with the dashboard in `ui.ts` so both pages look like one tool. */
export const STYLES = `  :root {
    --bg: #0b0e14; --panel: #131824; --line: #232a3a; --ink: #e6e9f0;
    --dim: #8b94a8; --accent: #5eead4; --warn: #fbbf24; --bad: #f87171; --good: #4ade80;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header { padding: 28px 24px 20px; border-bottom: 1px solid var(--line); }
  h1 { margin: 0 0 6px; font-size: 20px; letter-spacing: -.01em; }
  h2 { margin: 36px 0 12px; font-size: 14px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
  main { padding: 0 24px 64px; max-width: 1400px; }
  .sub { color: var(--dim); font-size: 13px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
  .chip {
    font: 11px/1 var(--mono); padding: 6px 9px; border: 1px solid var(--line);
    border-radius: 999px; color: var(--dim); white-space: nowrap;
  }
  .chip b { color: var(--ink); font-weight: 600; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-top: 20px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .card .k { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--dim); }
  .card .v { font: 600 24px/1.2 var(--mono); margin-top: 6px; letter-spacing: -.02em; }
  .card .n { font-size: 11px; color: var(--dim); margin-top: 4px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 10px; }
  .chart { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px 6px; }
  .chart .t { font-size: 12px; color: var(--dim); display: flex; justify-content: space-between; }
  .chart .t b { color: var(--ink); font: 600 12px var(--mono); }
  table { width: 100%; border-collapse: collapse; font: 12px/1.4 var(--mono); }
  th, td { padding: 7px 10px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--dim); font-weight: 500; text-align: right; position: sticky; top: 0; background: var(--bg); }
  th:first-child, td:first-child { text-align: left; white-space: normal; }
  tbody tr:hover { background: #ffffff08; }
  .wrap { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: auto; max-height: 560px; }
  .good { color: var(--good); } .bad { color: var(--bad); } .warn { color: var(--warn); } .dim { color: var(--dim); }
  .pill { font: 10px/1 var(--mono); padding: 3px 6px; border-radius: 4px; background: #ffffff10; }
  .pill.HIT { background: #4ade8022; color: var(--good); }
  .pill.MISS { background: #fbbf2422; color: var(--warn); }
  .banner { border-radius: 10px; padding: 12px 16px; margin-top: 16px; font-size: 13px; border: 1px solid; }
  .banner.ok { border-color: #4ade8044; background: #4ade8010; color: var(--good); }
  .banner.no { border-color: #f8717144; background: #f8717110; color: var(--bad); }
  .bar { height: 8px; border-radius: 4px; background: var(--accent); }
  dl { display: grid; grid-template-columns: 200px 1fr; gap: 6px 16px; margin: 0; font-size: 13px; }
  dt { color: var(--dim); } dd { margin: 0; font-family: var(--mono); font-size: 12px; }
`;

/** Inline SVG sparkline; both pages embed it in their own script tag. */
export const SPARK_JS = `function spark(series, colour) {
  const w = 480, h = 96, pad = 4;
  const values = series.map(v => (v === null ? 0 : v));
  const max = Math.max(...values, 1e-9), min = Math.min(...values, 0);
  const span = (max - min) || 1;
  const x = i => pad + (i / Math.max(1, series.length - 1)) * (w - pad * 2);
  const y = v => h - pad - ((v - min) / span) * (h - pad * 2);
  const line = values.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
  const area = line + ' L' + x(values.length - 1).toFixed(1) + ' ' + (h - pad) + ' L' + pad + ' ' + (h - pad) + ' Z';
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="width:100%;height:96px;display:block">'
    + '<defs><linearGradient id="' + id + '" x1="0" x2="0" y1="0" y2="1">'
    + '<stop offset="0%" stop-color="' + colour + '" stop-opacity=".28"/>'
    + '<stop offset="100%" stop-color="' + colour + '" stop-opacity="0"/></linearGradient></defs>'
    + '<path d="' + area + '" fill="url(#' + id + ')"/>'
    + '<path d="' + line + '" fill="none" stroke="' + colour + '" stroke-width="1.6" stroke-linejoin="round"/>'
    + '<text x="' + (w - pad) + '" y="12" text-anchor="end" fill="#8b94a8" font-size="9" font-family="monospace">max ' + n(max, max > 100 ? 0 : 1) + '</text>'
    + '</svg>';
}
`;

/**
 * One self-contained HTML file: the JSON goes in a script tag and the page
 * draws itself. Nothing is fetched, so the file survives being e-mailed.
 */
export function renderReport(data: object): string {
  const payload = JSON.stringify(data).replaceAll('<', '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API stress report</title>
<style>
${STYLES}</style>
</head>
<body>
<header>
  <h1>API stress &amp; cache report</h1>
  <div class="sub" id="head-sub"></div>
  <div class="chips" id="chips"></div>
</header>
<main>
  <div class="cards" id="cards"></div>
  <div id="ratelimit"></div>

  <h2>Cache effect</h2>
  <div class="grid" id="cache-cards"></div>
  <div id="invalidation"></div>

  <h2>Cold vs warm — every endpoint, one call each</h2>
  <div class="wrap"><table id="passes"></table></div>

  <h2>Under load</h2>
  <div class="grid" id="charts"></div>

  <h2>Per endpoint, under load</h2>
  <div class="wrap"><table id="endpoints"></table></div>

  <h2>Status codes &amp; errors</h2>
  <div class="grid">
    <div class="wrap"><table id="statuses"></table></div>
    <div class="wrap"><table id="errors"></table></div>
  </div>

  <h2>System</h2>
  <div class="grid">
    <div class="card"><dl id="sys-host"></dl></div>
    <div class="card"><dl id="sys-api"></dl></div>
    <div class="card"><dl id="sys-data"></dl></div>
  </div>
</main>

<script id="payload" type="application/json">${payload}</script>
<script>
const D = JSON.parse(document.getElementById('payload').textContent);
const $ = id => document.getElementById(id);
const n = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(d);
const ms = v => n(v, 1) + (v === null ? '' : ' ms');
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

$('head-sub').textContent = D.meta.baseUrl + ' · ' + new Date(D.meta.startedAt).toLocaleString()
  + ' · ' + D.meta.durationSeconds + 's of load';

$('chips').innerHTML = [
  ['sessions', D.meta.sessions], ['workers', D.meta.concurrency], ['endpoints', D.meta.endpointsCalled],
  ['stress scope', D.meta.stressScope],
  ['cache', D.meta.cacheEnabled ? 'on · ttl ' + D.meta.cacheTtlSeconds + 's' : 'off'],
  ['rate limit', D.meta.rateLimitPerMinute ? D.meta.rateLimitPerMinute + '/min' : 'n/a'],
  ['db pool', D.system.api.dbPoolMax],
].map(([k, v]) => '<span class="chip">' + k + ' <b>' + esc(v) + '</b></span>').join('');

const s = D.stress, peak = k => Math.max(0, ...D.timeline.map(r => r[k] ?? 0));
const card = (k, v, note) => '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="n">' + (note || '') + '</div></div>';

const hit = s.byCache.HIT, miss = s.byCache.MISS;
$('cards').innerHTML = [
  card('throughput', n(s.rps, 1), 'req/s · ' + s.totalRequests + ' requests'),
  card('p50', n(s.latency.p50, 1) + '<span class="dim" style="font-size:13px"> ms</span>', 'mean ' + ms(s.latency.mean)),
  card('p95', n(s.latency.p95, 1) + '<span class="dim" style="font-size:13px"> ms</span>', 'p99 ' + ms(s.latency.p99)),
  card('max', n(s.latency.max, 0) + '<span class="dim" style="font-size:13px"> ms</span>', 'min ' + ms(s.latency.min)),
  card('errors', '<span class="' + (s.errorRate > 1 ? 'bad' : 'good') + '">' + n(s.errorRate, 2) + '%</span>',
    s.rateLimited ? s.rateLimited + ' rate-limited' : 'of ' + s.totalRequests),
  card('cache hit rate', n(cacheHitRate(), 1) + '%', 'across cacheable reads'),
  card('api cpu peak', n(peak('apiCpuPct'), 0) + '%', 'of one core · ' + D.system.host.cores + ' cores'),
  card('api rss peak', n(peak('apiRssMb'), 0) + ' MB', 'heap ' + n(peak('apiHeapMb'), 0) + ' MB'),
  card('event loop lag', n(peak('eventLoopLagMs'), 1) + ' ms', 'peak mean lag'),
  card('transferred', n(s.bytes / 1024 / 1024, 1) + ' MB', n(s.bytes / 1024 / s.totalRequests, 1) + ' KB / request'),
].join('');

function cacheHitRate() {
  const h = hit ? hit.count : 0, m = miss ? miss.count : 0;
  return h + m === 0 ? 0 : (h / (h + m)) * 100;
}

if (s.rateLimited > s.totalRequests * 0.01) {
  $('ratelimit').innerHTML = '<div class="banner no"><b>' + s.rateLimited + ' requests were rate-limited (429).</b> '
    + 'This run measured the limiter as much as the API. Restart the server with '
    + '<code>RATE_LIMIT_MAX=1000000 SIGN_IN_RATE_LIMIT_MAX=1000000 pnpm dev</code> and run again.</div>';
}

const cacheRows = [
  ['served from Redis (x-cache: HIT)', hit],
  ['built from Postgres (x-cache: MISS)', miss],
  ['not cacheable', s.byCache['-']],
].filter(r => r[1]);
const worst = Math.max(...cacheRows.map(r => r[1].p95), 1);
$('cache-cards').innerHTML = cacheRows.map(([label, l]) =>
  '<div class="card"><div class="k">' + label + '</div>'
  + '<div class="v">' + n(l.p95, 1) + '<span class="dim" style="font-size:13px"> ms p95</span></div>'
  + '<div class="bar" style="width:' + (l.p95 / worst * 100) + '%;margin:10px 0 6px"></div>'
  + '<div class="n">' + l.count.toLocaleString() + ' requests · p50 ' + ms(l.p50) + ' · p99 ' + ms(l.p99) + '</div></div>',
).join('') + (hit && miss
  ? '<div class="card"><div class="k">cache pays</div><div class="v good">' + n(miss.p95 / hit.p95, 1) + '×</div>'
    + '<div class="n">p95 faster on a hit · saves ' + ms(miss.p95 - hit.p95) + '</div></div>'
  : '');

const inv = D.invalidation;
$('invalidation').innerHTML = !inv.ran
  ? '<div class="banner no">Invalidation check skipped: ' + esc(inv.reason || 'unknown') + '</div>'
  : '<div class="banner ' + (inv.passed ? 'ok' : 'no') + '"><b>Write-through invalidation '
    + (inv.passed ? 'works' : 'FAILED') + '.</b> '
    + inv.steps.map(x => esc(x.step) + ' → ' + x.status + (x.cache !== '-' ? ' ' + x.cache : '') + ' ' + n(x.ms, 1) + 'ms').join(' &nbsp;·&nbsp; ')
    + (inv.cacheKeysAfter !== null ? ' &nbsp;·&nbsp; ' + inv.cacheKeysAfter + ' cache keys left' : '') + '</div>';

table('passes',
  ['endpoint', 'status', 'cold', 'warm', 'speedup', 'cold', 'warm', 'bytes', 'customer'],
  D.cachePasses.map(r => [
    esc(r.key) + (r.error ? '<div class="dim" style="font:11px var(--mono);white-space:normal;margin-top:3px">' + esc(r.error) + '</div>' : ''),
    cell(r.status, r.status >= 200 && r.status < 400 ? 'good' : 'bad'),
    ms(r.coldMs), ms(r.warmMs),
    r.speedup ? cell(n(r.speedup, 1) + '×', r.speedup > 1.5 ? 'good' : 'dim') : '<span class="dim">—</span>',
    pill(r.coldCache), pill(r.warmCache),
    (r.bytes / 1024).toFixed(1) + ' KB',
    r.customerOk ? '<span class="good">yes</span>' : '<span class="dim">admin only</span>',
  ]));

table('endpoints',
  ['endpoint', 'requests', 'errors', 'hit %', 'p50', 'p95', 'p99', 'max', 'avg size'],
  s.byEndpoint.map(r => [
    esc(r.key), r.count,
    cell(r.errors, r.errors ? 'bad' : 'dim'),
    n(r.hitRatePct, 0) + '%',
    ms(r.p50), ms(r.p95), ms(r.p99), ms(r.max),
    (r.avgBytes / 1024).toFixed(1) + ' KB',
  ]));

table('statuses', ['status', 'count', 'share'],
  Object.entries(s.byStatus).sort((a, b) => b[1] - a[1]).map(([code, count]) => [
    cell(code === '0' ? 'network error' : code, Number(code) >= 400 || code === '0' ? 'bad' : 'good'),
    count, n(count / s.totalRequests * 100, 1) + '%',
  ]));

table('errors', ['failure', 'count'],
  s.errors.length ? s.errors.map(e => [esc(e.label), e.count]) : [['<span class="dim">none</span>', '']]);

function cell(v, cls) { return '<span class="' + cls + '">' + v + '</span>'; }
function pill(v) { return v === '-' ? '<span class="dim">—</span>' : '<span class="pill ' + v + '">' + v + '</span>'; }

function table(id, head, rows) {
  $(id).innerHTML = '<thead><tr>' + head.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody>';
}

const CHARTS = [
  ['throughput', 'rps', 'req/s', '#5eead4'],
  ['latency p95', 'p95', 'ms', '#818cf8'],
  ['api process cpu', 'apiCpuPct', '% of a core', '#fbbf24'],
  ['api resident memory', 'apiRssMb', 'MB', '#f472b6'],
  ['api heap used', 'apiHeapMb', 'MB', '#c084fc'],
  ['event loop lag', 'eventLoopLagMs', 'ms', '#fb923c'],
  ['host cpu (all cores)', 'hostCpuPct', '%', '#facc15'],
  ['host free memory', 'hostFreeMb', 'MB', '#94a3b8'],
  ['redis keys', 'redisKeys', 'keys', '#4ade80'],
  ['redis memory', 'redisMemMb', 'MB', '#2dd4bf'],
  ['postgres backends', 'pgBackends', 'connections', '#60a5fa'],
  ['postgres buffer hit', 'pgCacheHitPct', '%', '#34d399'],
];

$('charts').innerHTML = CHARTS.map(([title, key, unit, colour]) => {
  const series = D.timeline.map(r => r[key]).map(v => (v === null || v === undefined ? null : v));
  const shown = series.filter(v => v !== null);
  if (shown.length === 0) return '';
  const last = shown[shown.length - 1];
  return '<div class="chart"><div class="t"><span>' + title + '</span><b>' + n(last, last > 100 ? 0 : 1) + ' ' + unit + '</b></div>'
    + spark(series, colour) + '</div>';
}).join('');

${SPARK_JS}
function dl(id, pairs) {
  $(id).innerHTML = pairs.filter(p => p[1] !== null && p[1] !== undefined)
    .map(([k, v]) => '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>').join('');
}

dl('sys-host', [
  ['platform', D.system.host.platform], ['cpu', D.system.host.cpu], ['cores', D.system.host.cores],
  ['total memory', D.system.host.totalMemoryGb + ' GB'],
  ['load generator', 'node ' + D.system.host.loadGeneratorNode],
  ['note', D.system.host.note],
]);
dl('sys-api', [
  ['api', D.system.api.url], ['node', D.system.api.nodeVersion],
  ['rss at end', n(D.system.api.rssMbAtEnd, 0) + ' MB'],
  ['heap at end', n(D.system.api.heapMbAtEnd, 0) + ' MB'],
  ['cpu seconds total', n(D.system.api.cpuSecondsTotal, 1)],
  ['pg pool max', D.system.api.dbPoolMax],
  ['postgres', D.system.postgres.version],
  ['redis', D.system.redis.enabled ? D.system.redis.version : 'disabled'],
]);
dl('sys-data', Object.entries(D.system.dataset).map(([k, v]) => [k.replace(/_/g, ' '), v])
  .concat([['cache keys flushed', D.meta.cacheKeysFlushedBeforeCold]]));
</script>
</body>
</html>`;
}
