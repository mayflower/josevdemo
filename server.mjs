import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join, extname} from 'node:path';
import {once} from 'node:events';
import {parseArgs} from 'node:util';
import {readConfig, publicConfig, isConfigured} from './lib/config.mjs';
import {scenarios, bankingCategories, feedPresets, triageQuestions, documentCategories} from './data/fixtures.mjs';
import {selectRun, InputError, warmupTask} from './lib/tasks.mjs';
import {prepareRun, runExperiment} from './lib/runner.mjs';
import {invokeJosev, invokeLlm, ProviderError} from './lib/providers.mjs';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const mime = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'};

function json(res, status, value) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new InputError('Content-Type application/json erforderlich.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new InputError('Die Anfrage ist zu groß (maximal 64 KiB).', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('Ungültiges JSON.'); }
}

function requestAllowed(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // CLI and trusted reverse proxies.
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export function createApp(config = readConfig(), injectedProviders) {
  let active = false;
  const providers = injectedProviders || {josev: invokeJosev, llm: invokeLlm};
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    let path;
    try { path = new URL(req.url, 'http://localhost').pathname; } catch { return json(res, 400, {error: 'Ungültige URL.'}); }
    try {
      if (path.startsWith('/api/') && !requestAllowed(req)) return json(res, 403, {error: 'Die API ist nur aus derselben Webanwendung aufrufbar.'});
      if (req.method === 'GET' && path === '/api/config') return json(res, 200, publicConfig(config));
      if (req.method === 'GET' && path === '/api/scenarios') return json(res, 200, {scenarios, bankingCategories, feedPresets, triageQuestions, documentCategories, synthetic: true});
      if (req.method === 'GET' && path === '/api/health') {
        if (active) return json(res, 409, {error: 'Ein Lauf ist aktiv. Der Verbindungstest wartet bis zum Ende, damit die Messung unverändert bleibt.'});
        active = true;
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          const health = {};
          // Check actual typed/chat inference; /api/tags alone does not establish decision support.
          for (const lane of ['josev', 'llm']) {
            if (!isConfigured(config[lane])) { health[lane] = {ok: false, configured: false, message: lane === 'josev' ? 'OLLAMA_BASE_URL und JOSEV_MODEL konfigurieren.' : 'Optional: LLM_MODEL konfigurieren.'}; continue; }
            try {
              const response = await providers[lane]({...config[lane], ...warmupTask, timeoutMs: config.timeoutMs, signal: controller.signal});
              health[lane] = {ok: true, configured: true, model: response.model, message: 'Modell antwortet im erwarteten Format.', latencyMs: response.timing.wallMs, usage: response.usage};
            } catch (error) {
              if (controller.signal.aborted) throw error;
              health[lane] = {ok: false, configured: true, message: error instanceof ProviderError ? error.message : 'Verbindungstest fehlgeschlagen.'};
            }
          }
          if (!controller.signal.aborted) json(res, 200, health);
        } finally { active = false; }
        return;
      }
      if (req.method === 'POST' && path === '/api/run') {
        if (active) return json(res, 409, {error: 'Es läuft bereits eine Messung oder ein Verbindungstest. Bitte zuerst beenden.'});
        const selection = selectRun(await readJson(req), config);
        const plan = prepareRun(selection, config);
        // Recheck after reading the request: another client may have started in the meantime.
        if (active) return json(res, 409, {error: 'Es läuft bereits eine Messung. Bitte zuerst beenden.'});
        active = true;
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(new DOMException('Browser hat den Lauf beendet.', 'AbortError')); });
        req.on('aborted', () => controller.abort());
        res.writeHead(200, {'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no'});
        res.flushHeaders();
        const emit = async event => {
          if (controller.signal.aborted || res.destroyed) throw controller.signal.reason || new DOMException('Verbindung beendet.', 'AbortError');
          if (!res.write(JSON.stringify(event) + '\n')) await once(res, 'drain', {signal: controller.signal});
        };
        try {
          await runExperiment(plan, config, emit, controller.signal, providers);
        } catch (error) {
          if (!controller.signal.aborted && !res.destroyed) await emit({type: 'error', message: error instanceof ProviderError || error instanceof InputError ? error.message : 'Der Lauf konnte nicht vollständig abgeschlossen werden.'});
        } finally { active = false; if (!res.destroyed) res.end(); }
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, {error: 'Methode nicht erlaubt.'});
      if (path.startsWith('/api/')) return json(res, 404, {error: 'Unbekannte API-Route.'});
      const file = path === '/' ? 'index.html' : path.slice(1);
      // Serve only direct public assets; never .env, source code, or arbitrary disk paths.
      if (!/^[a-zA-Z0-9_-]+\.(html|js|css|svg|ico)$/.test(file)) return json(res, 404, {error: 'Nicht gefunden.'});
      let content;
      try { content = await readFile(join(publicDir, file)); } catch { return json(res, 404, {error: 'Nicht gefunden.'}); }
      res.writeHead(200, {'content-type': mime[extname(file)], 'cache-control': 'no-cache'});
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.end();
      json(res, error instanceof InputError ? error.status : 500, {error: error instanceof InputError ? error.message : 'Interner Fehler bei der Anfrage.'});
    }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 30000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const {values} = parseArgs({options: {host: {type: 'string'}, port: {type: 'string'}, strictPort: {type: 'boolean'}}});
    const config = readConfig({...process.env, HOST: values.host || process.env.HOST, PORT: values.port || process.env.PORT});
    const server = createApp(config);
    server.listen(config.port, config.host, () => {
      console.log(`Josev Decision Lab: http://${config.host}:${server.address().port}`);
      console.log(`Josev ${isConfigured(config.josev) ? 'konfiguriert' : 'noch nicht konfiguriert'} · LLM ${isConfigured(config.llm) ? 'konfiguriert' : 'optional, noch nicht konfiguriert'}`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
