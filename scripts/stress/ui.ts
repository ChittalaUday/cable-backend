import type { Buffer } from 'node:buffer';
/**
 * Every run in `perf/` on one page: how they compare, how they trend, and a
 * button that starts another one and streams its output back.
 *
 *   pnpm stress:ui            # http://127.0.0.1:5177
 *
 * Binds to loopback only — it spawns the test runner, so it is not something
 * to expose. Arguments are built as an array and never go near a shell.
 */
import type { ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { SPARK_JS, STYLES } from './report';
import { arg } from './shared';

const PORT = Number(arg('port', '5177'));
const OUT_DIR = path.resolve(process.cwd(), arg('out', 'perf'));

/** Only the fields the dashboard reads. `run.ts` writes the rest. */
interface RawReport {
  meta: {
    startedAt: string;
    baseUrl: string;
    sessions: number;
    concurrency: number;
    durationSeconds: number;
    stressScope: string;
  };
  stress: {
    totalRequests: number;
    rps: number;
    errorRate: number;
    rateLimited: number;
    latency: { p50: number; p95: number; p99: number };
    byCache: Record<string, { p95: number; count: number } | undefined>;
  };
  timeline?: Array<Record<string, unknown>>;
  cachePasses?: Array<{ key: string; status: number; error: string | null }>;
  invalidation?: { passed?: boolean };
}

interface Summary {
  file: string;
  report: string;
  startedAt: string;
  baseUrl: string;
  sessions: number;
  concurrency: number;
  durationSeconds: number;
  scope: string;
  requests: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  errorRatePct: number;
  rateLimited: number;
  hitP95: number | null;
  missP95: number | null;
  speedup: number | null;
  hitRatePct: number;
  apiCpuPeakPct: number | null;
  apiRssPeakMb: number | null;
  eventLoopPeakMs: number | null;
  broken: Array<{ key: string; status: number; error: string | null }>;
  invalidationPassed: boolean | null;
}

function peak(rows: Array<Record<string, unknown>>, key: string): number | null {
  const values = rows.map(r => r[key]).filter((v): v is number => typeof v === 'number');
  return values.length === 0 ? null : Math.max(...values);
}

async function summaries(): Promise<Summary[]> {
  const files = (await fs.readdir(OUT_DIR).catch(() => [])).filter(f => f.endsWith('.json')).sort().reverse();

  const parsed = await Promise.all(files.map(async (file) => {
    try {
      const data = JSON.parse(await fs.readFile(path.join(OUT_DIR, file), 'utf8')) as RawReport;
      const { meta, stress } = data;
      const timeline = data.timeline ?? [];
      const hit = stress.byCache.HIT;
      const miss = stress.byCache.MISS;
      const passes = data.cachePasses ?? [];

      return {
        file,
        report: file.replace(/\.json$/, '.html'),
        startedAt: meta.startedAt,
        baseUrl: meta.baseUrl,
        sessions: meta.sessions,
        concurrency: meta.concurrency,
        durationSeconds: meta.durationSeconds,
        scope: meta.stressScope,
        requests: stress.totalRequests,
        rps: stress.rps,
        p50: stress.latency.p50,
        p95: stress.latency.p95,
        p99: stress.latency.p99,
        errorRatePct: stress.errorRate,
        rateLimited: stress.rateLimited,
        hitP95: hit?.p95 ?? null,
        missP95: miss?.p95 ?? null,
        speedup: hit !== undefined && miss !== undefined && hit.p95 > 0 ? miss.p95 / hit.p95 : null,
        hitRatePct: hit === undefined ? 0 : (hit.count / (hit.count + (miss?.count ?? 0))) * 100,
        apiCpuPeakPct: peak(timeline, 'apiCpuPct'),
        apiRssPeakMb: peak(timeline, 'apiRssMb'),
        eventLoopPeakMs: peak(timeline, 'eventLoopLagMs'),
        broken: passes.filter(p => p.status >= 400).map(p => ({ key: p.key, status: p.status, error: p.error })),
        invalidationPassed: data.invalidation?.passed ?? null,
      } satisfies Summary;
    }
    catch {
      return null;
    }
  }));

  return parsed.filter((s): s is Summary => s !== null);
}

// ─── the one run at a time ────────────────────────────────────────────────────

interface Active { args: string[]; lines: string[]; startedAt: number; exitCode: number | null }

let active: Active | null = null;
const watchers = new Set<ServerResponse>();

function broadcast(event: string, payload: unknown): void {
  for (const watcher of watchers)
    watcher.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** Only ever numbers and a URL reach the argument list, and never a shell. */
function argsFrom(body: Record<string, unknown>): string[] {
  const num = (key: string, fallback: number, max: number) => {
    const value = Number(body[key]);
    return String(Math.min(max, Math.max(1, Number.isFinite(value) ? Math.floor(value) : fallback)));
  };

  const url = typeof body.url === 'string' && /^https?:\/\/[\w.:@-]+$/.test(body.url) ? body.url : null;

  return [
    ...(url === null ? [] : [`--url=${url}`]),
    `--users=${num('users', 300, 5000)}`,
    `--concurrency=${num('concurrency', 40, 2000)}`,
    `--duration=${num('duration', 30, 900)}`,
    ...(body.allEndpoints === true ? ['--all-endpoints'] : []),
    ...(body.noWrites === true ? ['--no-writes'] : []),
  ];
}

function startRun(body: Record<string, unknown>): Active {
  const args = argsFrom(body);
  const run: Active = { args, lines: [], startedAt: Date.now(), exitCode: null };
  active = run;

  // `pnpm exec` resolves tsx out of node_modules/.bin, which beats guessing
  // where the loader lives. An array, so nothing reaches a shell.
  const child = spawn(
    'pnpm',
    ['exec', 'tsx', '--env-file-if-exists=.env', 'scripts/stress/run.ts', ...args],
    { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const feed = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(l => l.trim() !== '')) {
      run.lines.push(line);
      broadcast('line', line);
    }
  };

  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('close', (code) => {
    run.exitCode = code ?? -1;
    broadcast('done', { code: run.exitCode });
  });

  return run;
}

// ─── page ─────────────────────────────────────────────────────────────────────

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stress dashboard</title>
<style>
${STYLES}
  .run { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; align-items: end; }
  label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--dim); margin-bottom: 5px; }
  input[type=text], input[type=number] {
    width: 100%; background: var(--bg); border: 1px solid var(--line); border-radius: 7px;
    color: var(--ink); padding: 8px 10px; font: 12px var(--mono);
  }
  .check { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--dim); padding-bottom: 9px; }
  button {
    background: var(--accent); color: #06231f; border: 0; border-radius: 7px; padding: 10px 18px;
    font: 600 13px system-ui; cursor: pointer;
  }
  button:disabled { background: var(--line); color: var(--dim); cursor: not-allowed; }
  pre {
    margin: 12px 0 0; padding: 12px 14px; background: #05070c; border: 1px solid var(--line);
    border-radius: 8px; font: 11.5px/1.6 var(--mono); color: var(--ink); max-height: 260px;
    overflow: auto; white-space: pre-wrap;
  }
  tbody tr { cursor: pointer; }
  .latest { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
</head>
<body>
<header>
  <h1>Stress dashboard</h1>
  <div class="sub" id="sub">loading…</div>
</header>
<main>
  <h2>New run</h2>
  <div class="card">
    <div class="run">
      <div><label for="url">target url</label><input id="url" type="text" placeholder="http://localhost:5050"></div>
      <div><label for="users">sessions</label><input id="users" type="number" value="300" min="1"></div>
      <div><label for="concurrency">workers</label><input id="concurrency" type="number" value="40" min="1"></div>
      <div><label for="duration">seconds</label><input id="duration" type="number" value="30" min="1"></div>
      <div class="check"><input id="allEndpoints" type="checkbox"><label for="allEndpoints" style="margin:0">all endpoints</label></div>
      <div class="check"><input id="noWrites" type="checkbox"><label for="noWrites" style="margin:0">no writes</label></div>
      <div><button id="go">Run</button></div>
    </div>
    <pre id="log">Nothing running. Reports below are read from the perf directory.</pre>
  </div>

  <h2>Across runs</h2>
  <div class="grid" id="trends"></div>

  <h2>Runs</h2>
  <div class="wrap"><table id="runs"></table></div>

  <h2>Endpoints failing in the latest sweep</h2>
  <div class="wrap"><table id="broken"></table></div>
</main>
<script>
const $ = id => document.getElementById(id);
const n = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(d);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
let RUNS = [];

${SPARK_JS}

async function load() {
  RUNS = await fetch('/api/runs').then(r => r.json());
  $('sub').textContent = RUNS.length + ' run' + (RUNS.length === 1 ? '' : 's') + ' on file'
    + (RUNS.length ? ' · latest ' + new Date(RUNS[0].startedAt).toLocaleString() + ' against ' + RUNS[0].baseUrl : '');

  if (RUNS.length === 0) {
    $('runs').innerHTML = '<tbody><tr><td class="dim">No reports yet — start a run above.</td></tr></tbody>';
    return;
  }

  if (!$('url').value) $('url').value = RUNS[0].baseUrl;

  table('runs',
    ['when', 'target', 'load', 'req/s', 'p50', 'p95', 'p99', 'errors', 'HIT p95', 'MISS p95', 'cache pays', 'hit rate', 'api cpu', 'api rss', 'report'],
    RUNS.map((r, i) => ({
      cls: i === 0 ? 'latest' : '',
      cells: [
        new Date(r.startedAt).toLocaleString(),
        esc(r.baseUrl.replace(/^https?:\\/\\//, '')),
        r.concurrency + 'w × ' + r.durationSeconds + 's · ' + r.sessions + ' sessions',
        '<b>' + n(r.rps, 0) + '</b>',
        n(r.p50) + 'ms', n(r.p95) + 'ms', n(r.p99) + 'ms',
        '<span class="' + (r.errorRatePct > 1 ? 'bad' : 'good') + '">' + n(r.errorRatePct, 2) + '%</span>'
          + (r.rateLimited ? ' <span class="warn">' + r.rateLimited + ' 429</span>' : ''),
        n(r.hitP95) + 'ms', n(r.missP95) + 'ms',
        r.speedup ? '<span class="good">' + n(r.speedup) + '×</span>' : '—',
        n(r.hitRatePct, 0) + '%',
        n(r.apiCpuPeakPct, 0) + '%', n(r.apiRssPeakMb, 0) + 'MB',
        '<a href="/report/' + r.report + '" target="_blank" style="color:var(--accent)">open ↗</a>',
      ],
    })));

  const ordered = [...RUNS].reverse();
  $('trends').innerHTML = [
    ['throughput', r => r.rps, 'req/s', '#5eead4'],
    ['latency p95', r => r.p95, 'ms', '#818cf8'],
    ['cache pays', r => r.speedup, '×', '#4ade80'],
    ['api cpu peak', r => r.apiCpuPeakPct, '%', '#fbbf24'],
    ['api rss peak', r => r.apiRssPeakMb, 'MB', '#f472b6'],
    ['error rate', r => r.errorRatePct, '%', '#f87171'],
  ].map(([title, pick, unit, colour]) => {
    const series = ordered.map(pick).map(v => (v === null || v === undefined ? 0 : v));
    const last = series[series.length - 1];
    return '<div class="chart"><div class="t"><span>' + title + ' · ' + series.length + ' runs</span>'
      + '<b>' + n(last, last > 100 ? 0 : 1) + ' ' + unit + '</b></div>' + spark(series, colour) + '</div>';
  }).join('');

  const broken = RUNS[0].broken;
  table('broken', ['endpoint', 'status', 'reason'], broken.length
    ? broken.map(b => ({ cells: [esc(b.key), '<span class="' + (b.status >= 500 ? 'bad' : 'warn') + '">' + b.status + '</span>', '<span class="dim">' + esc(b.error || '') + '</span>'] }))
    : [{ cells: ['<span class="good">Every endpoint answered 2xx.</span>', '', ''] }]);
}

function table(id, head, rows) {
  $(id).innerHTML = '<thead><tr>' + head.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map(r => '<tr class="' + (r.cls || '') + '">' + r.cells.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('')
    + '</tbody>';
}

const log = [];
function append(line) {
  log.push(line);
  $('log').textContent = log.slice(-400).join('\\n');
  $('log').scrollTop = $('log').scrollHeight;
}

const stream = new EventSource('/api/log');
stream.addEventListener('line', e => append(JSON.parse(e.data)));
stream.addEventListener('done', (e) => {
  append('— finished with exit code ' + JSON.parse(e.data).code + ' —');
  $('go').disabled = false;
  $('go').textContent = 'Run';
  load();
});

$('go').onclick = async () => {
  log.length = 0;
  $('go').disabled = true;
  $('go').textContent = 'Running…';
  const body = {
    url: $('url').value.trim(),
    users: +$('users').value,
    concurrency: +$('concurrency').value,
    duration: +$('duration').value,
    allEndpoints: $('allEndpoints').checked,
    noWrites: $('noWrites').checked,
  };
  const res = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json();
  if (!res.ok) {
    append(out.error);
    $('go').disabled = false;
    $('go').textContent = 'Run';
    return;
  }
  append('$ pnpm stress ' + out.args.join(' '));
};

fetch('/api/state').then(r => r.json()).then((s) => {
  if (s.running) {
    $('go').disabled = true;
    $('go').textContent = 'Running…';
  }
});

load();
</script>
</body>
</html>`;

// ─── server ───────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (url.pathname === '/api/runs') {
    void summaries().then(rows => json(res, 200, rows));
    return;
  }

  if (url.pathname === '/api/state') {
    json(res, 200, active === null
      ? { running: false }
      : { running: active.exitCode === null, args: active.args, lines: active.lines, exitCode: active.exitCode });
    return;
  }

  if (url.pathname === '/api/log') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
    for (const line of active?.lines ?? [])
      res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`);

    watchers.add(res);
    req.on('close', () => watchers.delete(res));
    return;
  }

  if (url.pathname === '/api/run' && req.method === 'POST') {
    if (active !== null && active.exitCode === null) {
      json(res, 409, { error: 'A run is already in flight.' });
      return;
    }

    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      const body = ((): Record<string, unknown> => {
        try {
          return JSON.parse(raw || '{}') as Record<string, unknown>;
        }
        catch {
          return {};
        }
      })();

      json(res, 202, { args: startRun(body).args });
    });
    return;
  }

  // Reports are served by name out of the report directory only — the name has
  // to be one the listing produced, so there is nothing to traverse with.
  if (url.pathname.startsWith('/report/')) {
    const wanted = url.pathname.slice('/report/'.length);
    void summaries().then(async (rows) => {
      if (!rows.some(r => r.report === wanted)) {
        json(res, 404, { error: 'No such report.' });
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await fs.readFile(path.join(OUT_DIR, wanted)));
    });
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`📊 Stress dashboard on http://127.0.0.1:${PORT}  (reports from ${OUT_DIR})`);
});
