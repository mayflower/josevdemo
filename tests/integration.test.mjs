import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';
import { metricsFor, tokenCost } from '../lib/runner.mjs';
import { scenarios, bankingCategories } from '../data/fixtures.mjs';

// These are protocol integration tests. The scripted HTTP service chooses the
// first allowed option or false, independently of every fixture's expected
// answer. Its delays and responses are never used as model benchmark results.
function scriptAnswer(questions) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [
    id,
    question.type === 'noul'
      ? { type: 'noul', noul: id === 'ready' ? 0.98 : 0.25 }
      : { type: 'choice', choice: Object.keys(question.criteria)[0], probabilities: Object.fromEntries(Object.keys(question.criteria).map((key, i) => [key, i === 0 ? 1 : 0])) },
  ]));
}

function parsedRequest(path, body) {
  return path.endsWith('/api/chat') ? JSON.parse(body.messages[1].content) : body;
}

function respondModel(res, path, body) {
  const input = parsedRequest(path, body);
  const answers = scriptAnswer(input.questions);
  const warmup = Object.hasOwn(input.questions, 'ready');
  const data = path.endsWith('/api/chat') ? {
    model: body.model,
    message: { role: 'assistant', content: JSON.stringify(Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, answer.type === 'noul' ? answer.noul >= 0.5 : answer.choice]))) },
    done: true, prompt_eval_count: warmup ? 777 : 12, eval_count: warmup ? 3 : 4,
    load_duration: 0, prompt_eval_duration: 2_000_000, eval_duration: 3_000_000,
  } : {
    model: body.model, answers, usage: { input_tokens: warmup ? 777 : 10, output_tokens: 0 },
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function withApp(config, run) {
  const server = createApp(config);
  const origin = await listen(server);
  try { return await run(origin); } finally { await close(server); }
}

async function withModel(handler, run) {
  const captured = [];
  const server = http.createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk.toString();
      const body = JSON.parse(text);
      captured.push({ path: req.url, body });
      await handler(req, res, body);
    } catch (error) { res.destroy(error); }
  });
  const origin = await listen(server);
  try { return await run(origin, captured); } finally { await close(server); }
}

function configFor(modelOrigin, extra = {}) {
  return readConfig({ OLLAMA_BASE_URL: modelOrigin, JOSEV_MODEL: 'josev-test', LLM_MODEL: 'llm-test', PORT: '0', REQUEST_TIMEOUT_MS: '1000', ...extra });
}

function fetchRun(origin, body, signal) {
  return fetch(`${origin}/api/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
}

async function eventsFrom(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  return (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('unconfigured HTTP app exposes synthetic cases and safe config without invoking a model', async () => {
  await withApp(readConfig({}), async origin => {
    const config = await (await fetch(`${origin}/api/config`)).json();
    assert.equal(config.josev.configured, false);
    assert.equal(config.llm.configured, false);
    assert.equal(config.josev.costPerHour, null);
    assert.ok(!Object.hasOwn(config.josev, 'apiKey'));
    assert.ok(!Object.hasOwn(config.josev, 'baseUrl'));
    const data = await (await fetch(`${origin}/api/scenarios`)).json();
    assert.equal(data.synthetic, true);
    assert.deepEqual(data.scenarios.map(scenario => scenario.id), ['triage', 'feed', 'extract', 'documents', 'banking']);
    assert.equal(data.bankingCategories.length, 77);
    assert.equal(new Set(data.bankingCategories.map(category => category.id)).size, 77);
    const run = await fetchRun(origin, { scenario: 'triage', count: 1 });
    assert.equal(run.status, 503);
    assert.match((await run.json()).error, /OLLAMA_BASE_URL/);
    const health = await (await fetch(`${origin}/api/health`)).json();
    assert.equal(health.josev.configured, false);
    assert.equal(health.llm.configured, false);
    assert.equal((await fetch(`${origin}/.env`)).status, 404);
  });
});

test('real HTTP adapter calls produce NDJSON results; warm-up usage stays outside measured metrics', async () => {
  await withModel(async (req, res, body) => {
    const { questions } = parsedRequest(req.url, body);
    await pause(Object.hasOwn(questions, 'ready') ? 20 : 5);
    respondModel(res, req.url, body);
  }, async (modelOrigin, captured) => {
    await withApp(configFor(modelOrigin, { JOSEV_COST_PER_HOUR_EUR: '3.6', LLM_COST_PER_HOUR_EUR: '7.2' }), async origin => {
      const events = await eventsFrom(await fetchRun(origin, { scenario: 'triage', mode: 'compare', count: 2, concurrency: 1, warmup: true }));
      assert.equal(events[0].type, 'run');
      const results = events.filter(event => event.type === 'result');
      assert.equal(results.length, 4);
      assert.ok(results.every(result => result.status === 'ok'));
      const done = events.at(-1);
      assert.equal(done.type, 'done');
      for (const lane of ['josev', 'llm']) {
        const metrics = done.metrics[lane];
        assert.equal(metrics.successful, 2);
        assert.equal(metrics.items, 2);
        assert.equal(metrics.warmup.ok, true);
        assert.equal(metrics.warmup.usage.inputTokens, 777);
        assert.equal(metrics.inputTokens, lane === 'josev' ? 20 : 24);
        assert.equal(metrics.outputTokens, lane === 'josev' ? 0 : 8);
        assert.equal(metrics.latencySamples, 2);
        assert.ok(metrics.totalWallMs > 0);
        assert.ok(metrics.cost > 0);
      }
      assert.ok(done.comparison);
      assert.equal(captured.length, 6);
      assert.ok(captured.slice(0, 3).every(request => request.path === '/v1/systemone'));
      assert.ok(captured.slice(3).every(request => request.path === '/api/chat'));
      const josevInputs = captured.slice(1, 3).map(request => parsedRequest(request.path, request.body));
      const llmInputs = captured.slice(4, 6).map(request => parsedRequest(request.path, request.body));
      for (let i = 0; i < 2; i++) {
        assert.equal(josevInputs[i].state, scenarios.find(scenario => scenario.id === 'triage').items[i].text);
        assert.deepEqual({ state: josevInputs[i].state, questions: josevInputs[i].questions }, llmInputs[i]);
      }
      for (const request of captured) assert.doesNotMatch(JSON.stringify(request.body), /"expected(?:ByPreset)?"\s*:/);
      const lastJosevResult = events.findLastIndex(event => event.type === 'result' && event.lane === 'josev');
      const firstLlmStart = events.findIndex(event => event.type === 'start' && event.lane === 'llm');
      assert.ok(firstLlmStart > lastJosevResult);
    });
  });
});

test('77-class banking uses three safe-key groups and one finalist request per model', async () => {
  await withModel((req, res, body) => respondModel(res, req.url, body), async (modelOrigin, captured) => {
    await withApp(configFor(modelOrigin), async origin => {
      const events = await eventsFrom(await fetchRun(origin, { scenario: 'banking', mode: 'compare', count: 1, warmup: false }));
      assert.equal(captured.length, 4);
      for (const offset of [0, 2]) {
        const first = parsedRequest(captured[offset].path, captured[offset].body);
        const second = parsedRequest(captured[offset + 1].path, captured[offset + 1].body);
        assert.deepEqual(Object.values(first.questions).map(question => Object.keys(question.criteria).length), [26, 26, 25]);
        const keys = Object.values(first.questions).flatMap(question => Object.keys(question.criteria));
        assert.equal(new Set(keys).size, 77);
        assert.ok(keys.every(key => /^i\d{2}$/.test(key)));
        assert.deepEqual(Object.keys(second.questions.intent.criteria), ['i01', 'i27', 'i53']);
        assert.equal(first.state, second.state);
      }
      const results = events.filter(event => event.type === 'result');
      assert.equal(results.length, 2);
      for (const result of results) {
        assert.equal(result.status, 'ok');
        assert.equal(result.stages, 2);
        assert.equal(result.decisions, 4);
        assert.equal(result.values.intent, bankingCategories[0].id);
        assert.match(result.probabilityScope, /drei Finalisten/);
        assert.deepEqual(result.trace[0].candidates, [bankingCategories[0].id, bankingCategories[26].id, bankingCategories[52].id]);
      }
      assert.equal(results[0].usage.inputTokens, 20);
      assert.equal(results[1].usage.inputTokens, 24);
      assert.equal(events.at(-1).metrics.josev.cost, null);
      assert.equal(events.at(-1).comparison.costRatio, null);
    });
  });
});

test('feed custom rules, extraction candidate decoding and document boundaries pass through the real API', async () => {
  await withModel((req, res, body) => respondModel(res, req.url, body), async (modelOrigin, captured) => {
    await withApp(configFor(modelOrigin), async origin => {
      const condition = 'Wird ausdrücklich ein Workshop in Dresden angekündigt?';
      const feed = await eventsFrom(await fetchRun(origin, { scenario: 'feed', count: 1, warmup: false, feedCondition: condition }));
      assert.equal(captured.at(-1).body.questions.match.instructions, condition);
      assert.equal(feed.find(event => event.type === 'result').correct, null);

      const text = 'Rechnung RE-2026-101. Rechnungsdatum 12.10.2026. Gesamtbetrag 120,00 EUR. Fällig am 30.10.2026.';
      const extract = await eventsFrom(await fetchRun(origin, { scenario: 'extract', count: 1, warmup: false, customText: text }));
      const extracted = extract.find(event => event.type === 'result');
      assert.equal(extracted.status, 'ok');
      assert.equal(extracted.values.invoice_number, 'RE-2026-101');
      assert.equal(extracted.values.total_due, '120,00 EUR');
      assert.equal(extracted.values.due_date, '12.10.2026'); // First candidate, deliberately not a quality claim.
      assert.equal(extracted.values.po_number, 'none');
      assert.equal(extracted.values.billing_email, 'none');
      assert.deepEqual(extracted.deterministicFields, ['po_number', 'billing_email']);
      assert.equal(extracted.correct, null);
      assert.equal(captured.at(-1).body.state, text);
      assert.ok(Object.keys(captured.at(-1).body.questions).every(key => !['po_number', 'billing_email'].includes(key)));

      const documents = await eventsFrom(await fetchRun(origin, { scenario: 'documents', count: 2, warmup: false }));
      assert.equal(documents.filter(event => event.type === 'result').length, 2);
      const input = captured.at(-1).body;
      const secondPage = scenarios.find(scenario => scenario.id === 'documents').items[1];
      assert.equal(input.state.aktuelle_seite, secondPage.text);
      assert.equal(input.state.vorherige_seite, secondPage.previousText || '(Keine vorherige Seite: Anfang des Stapels.)');
      assert.deepEqual(Object.keys(input.questions), ['category', 'new_document']);
    });
  });
});

test('concurrent work bills each elapsed interval once instead of adding overlapping request durations', async () => {
  const sample = [0, 1].map(() => ({ status: 'ok', latencyMs: 80, usage: { inputTokens: 10, outputTokens: 0 } }));
  const fixed = metricsFor(sample, 100, 3600);
  assert.equal(fixed.activeMs, 160);
  assert.equal(fixed.cost, 0.1);
  assert.equal(fixed.costPer1000, 50);
  let active = 0, peak = 0;
  await withModel(async (req, res, body) => {
    peak = Math.max(peak, ++active);
    await pause(25);
    active--;
    respondModel(res, req.url, body);
  }, async modelOrigin => {
    await withApp(configFor(modelOrigin, { JOSEV_COST_PER_HOUR_EUR: '3600' }), async origin => {
      const events = await eventsFrom(await fetchRun(origin, { scenario: 'triage', count: 2, concurrency: 2, warmup: false }));
      const metrics = events.at(-1).metrics.josev;
      assert.equal(peak, 2);
      assert.ok(metrics.activeMs > metrics.totalWallMs);
      assert.equal(metrics.cost, metrics.totalWallMs / 3_600_000 * 3600);
      const allocated = events.filter(event => event.type === 'result').reduce((sum, result) => sum + result.cost, 0);
      assert.ok(allocated <= metrics.cost);
      assert.ok(allocated > 0);
      assert.equal(events.findIndex(event => event.type === 'start' && event.index === 1) < events.findIndex(event => event.type === 'result'), true);
    });
  });
});

test('failed warm-up skips the lane and produces no invented speed or cost win', async () => {
  await withModel((req, res, body) => {
    if (req.url === '/v1/systemone') { res.writeHead(404); res.end('model missing'); }
    else respondModel(res, req.url, body);
  }, async (modelOrigin, captured) => {
    await withApp(configFor(modelOrigin, { JOSEV_COST_PER_HOUR_EUR: '1', LLM_COST_PER_HOUR_EUR: '1' }), async origin => {
      const events = await eventsFrom(await fetchRun(origin, { scenario: 'triage', mode: 'compare', count: 2, warmup: true }));
      const done = events.at(-1);
      assert.equal(captured.filter(request => request.path === '/v1/systemone').length, 1);
      assert.equal(done.metrics.josev.warmup.ok, false);
      assert.equal(done.metrics.josev.successful, 0);
      assert.equal(done.metrics.josev.skipped, 2);
      assert.equal(done.metrics.josev.complete, false);
      assert.equal(done.metrics.josev.totalWallMs, null);
      assert.equal(done.metrics.josev.cost, null);
      assert.equal(done.metrics.josev.costPer1000, null);
      assert.equal(done.metrics.llm.successful, 2);
      assert.equal(done.comparison, null);
      assert.ok(events.filter(event => event.type === 'result' && event.lane === 'josev').every(event => event.status === 'error' && event.skipped && event.latencyMs === null));
    });
  });
});

test('invalid JSON, range and baseline requests fail before inference', async () => {
  await withModel((req, res, body) => respondModel(res, req.url, body), async (modelOrigin, captured) => {
    await withApp(configFor(modelOrigin), async origin => {
      for (const body of [
        { scenario: 'missing' }, { scenario: 'triage', count: 0 }, { scenario: 'triage', count: 999999 },
        { scenario: 'triage', concurrency: 0 }, { scenario: 'triage', concurrency: '2' },
        { scenario: 'triage', warmup: 'false' },
      ]) assert.equal((await fetchRun(origin, body)).status, 400);
      assert.equal((await fetch(`${origin}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })).status, 400);
      assert.equal((await fetch(`${origin}/api/run`, { method: 'POST', body: '{}' })).status, 415);
      assert.equal((await fetch(`${origin}/api/config`, { headers: { origin: 'https://foreign.example' } })).status, 403);
    });
    await withApp(configFor(modelOrigin, { LLM_MODEL: '' }), async origin => {
      assert.equal((await fetchRun(origin, { scenario: 'triage', mode: 'compare', count: 1 })).status, 503);
    });
    assert.equal(captured.length, 0);
  });
});

test('browser abort cancels inference, prevents later items, and releases the single-run lock', async () => {
  let held = true, calls = 0, upstreamClosed = false;
  let markArrived;
  const arrived = new Promise(resolve => { markArrived = resolve; });
  await withModel((req, res, body) => {
    calls++;
    if (held) {
      res.on('close', () => { upstreamClosed = true; });
      markArrived();
      return;
    }
    respondModel(res, req.url, body);
  }, async modelOrigin => {
    await withApp(configFor(modelOrigin), async origin => {
      const controller = new AbortController();
      const response = await fetchRun(origin, { scenario: 'triage', count: 3, concurrency: 1, warmup: false }, controller.signal);
      assert.equal(response.status, 200);
      await arrived;
      assert.equal((await fetchRun(origin, { scenario: 'triage', count: 1 })).status, 409);
      assert.equal((await fetch(`${origin}/api/health`)).status, 409);
      controller.abort();
      await assert.rejects(response.text(), error => error.name === 'AbortError');
      for (let i = 0; i < 100 && !upstreamClosed; i++) await pause(5);
      assert.equal(upstreamClosed, true);
      assert.equal(calls, 1);
      held = false;
      let next;
      for (let i = 0; i < 100; i++) {
        next = await fetchRun(origin, { scenario: 'triage', count: 1, warmup: false });
        if (next.status !== 409) break;
        await next.text();
        await pause(5);
      }
      const events = await eventsFrom(next);
      assert.equal(events.at(-1).metrics.josev.successful, 1);
      assert.equal(calls, 2);
    });
  });
});

test('token pricing yields cost from reported usage and stays unknown without usage', () => {
  const pricing = { inputPerMTok: 0.1, outputPerMTok: 0.5 };
  assert.equal(tokenCost({ inputTokens: 2_000_000, outputTokens: 1_000_000 }, pricing), 0.7);
  assert.equal(tokenCost({ inputTokens: 10, outputTokens: null }, pricing), null);
  assert.equal(tokenCost({ inputTokens: 10, outputTokens: 1 }, null), null);
  const ok = { status: 'ok', latencyMs: 5, cost: 0.25, usage: { inputTokens: 1, outputTokens: 1 } };
  assert.equal(metricsFor([ok, ok], 100, null, null, pricing).cost, 0.5);
  assert.equal(metricsFor([ok, { ...ok, cost: null }], 100, 3600, null, pricing).cost, null);
});
