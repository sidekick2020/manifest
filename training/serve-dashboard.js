#!/usr/bin/env node
/**
 * Serve the training dashboard with auto-loaded run files.
 * Usage: node training/serve-dashboard.js
 * Opens at http://localhost:3333
 *
 * Endpoints:
 *   GET /           - dashboard HTML with auto-loaded run data
 *   POST /run-training  - spawn npm run training, stream output via SSE
 *   GET /runs       - JSON list of available run files
 */
import { createServer } from 'http';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3333;
const manifestDir = join(__dirname, '..');

function loadRuns() {
  const outputDir = join(__dirname, 'output');
  let runFiles = [];
  try {
    runFiles = readdirSync(outputDir)
      .filter(f => f.startsWith('run-') && f.endsWith('.json'))
      .sort();
  } catch (e) {
    // no output dir yet
  }
  const runData = [];
  for (const f of runFiles) {
    try {
      const data = JSON.parse(readFileSync(join(outputDir, f), 'utf-8'));
      data._filename = f;
      runData.push(data);
    } catch (e) {
      console.warn('Failed to parse', f, e.message);
    }
  }
  return runData;
}

const server = createServer((req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
    let html = readFileSync(join(__dirname, 'dashboard.html'), 'utf-8');
    const runData = loadRuns();

    const injection = `<script>
// Auto-loaded ${runData.length} run files from training/output/
const autoLoadedRuns = ${JSON.stringify(runData)};
if (autoLoadedRuns.length > 0) {
  runs.push(...autoLoadedRuns);
  document.getElementById('loadSection').style.display = 'none';
  document.getElementById('runSelectorWrap').style.display = 'block';
  renderRunSelector();
  selectRun(runs.length - 1);
}
</script>`;

    html = html.replace('</body>', injection + '\n</body>');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);

  } else if (req.method === 'GET' && req.url === '/runs') {
    const runData = loadRuns();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(runData));

  } else if (req.method === 'POST' && req.url === '/run-training') {
    // Server-Sent Events stream for live training output
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const send = (type, data) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('start', { message: 'Starting training pipeline...' });

    const child = spawn('npm', ['run', 'training'], {
      cwd: manifestDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    child.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        send('log', { line });
      }
    });

    child.stderr.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        send('log', { line, isError: true });
      }
    });

    child.on('close', (code) => {
      const runData = loadRuns();
      const latest = runData.length > 0 ? runData[runData.length - 1] : null;
      send('done', { code, latest });
      res.end();
    });

    req.on('close', () => {
      child.kill();
    });

  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  const runCount = loadRuns().length;
  console.log(`Training dashboard: http://localhost:${PORT}`);
  console.log(`Loaded ${runCount} run file(s) from training/output/`);
});
