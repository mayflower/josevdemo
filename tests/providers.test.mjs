import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { invokeJosev, invokeLlm, ProviderError } from '../lib/providers.mjs';

const questions = {
  refund: { type: 'noul', instructions: 'Wird eine Erstattung verlangt?', criteria: { false: 'Keine Erstattung verlangt', true: 'Erstattung verlangt' } },
  team: { type: 'choice', instructions: 'Welches Team ist zuständig?', criteria: { billing: 'Abrechnung und Zahlungen', technical: 'Technische Fehler' } },
};
const state = { nachricht: 'Die App hat doppelt abgebucht. Bitte erstatten Sie den zweiten Betrag.' };
const responseData = () => ({
  model: 'josev-test',
  answers: {
    refund: { type: 'noul', noul: 0.997 },
    team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.94, technical: 0.06 }, confidence: 0.8 },
  },
  usage: { input_tokens: 157, output_tokens: 0 },
});

async function withServer(handler, run) {
  const server = http.createServer(async (req, res) => {
    try {
      let text = '';
      for await (const part of req) text += part.toString();
      await handler(req, res, text ? JSON.parse(text) : undefined);
    } catch (error) {
      res.destroy(error);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(baseUrl);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function json(res, data) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

test('Josev sends typed System One request, preserves proxy prefix, and parses true probabilities', async () => {
  let received;
  await withServer((req, res, body) => {
    received = { url: req.url, method: req.method, authorization: req.headers.authorization, body };
    json(res, responseData());
  }, async baseUrl => {
    const result = await invokeJosev({ baseUrl: `${baseUrl}/ollama/`, model: 'josev-test', apiKey: 'test-secret', keepAlive: '20m', state, questions });
    assert.deepEqual(received, {
      url: '/ollama/v1/systemone', method: 'POST', authorization: 'Bearer test-secret',
      body: { model: 'josev-test', state, questions, keep_alive: '20m' },
    });
    assert.deepEqual(result.answers, {
      refund: { value: true, probability: 0.997, probabilities: null },
      team: { value: 'billing', probability: 0.94, probabilities: { billing: 0.94, technical: 0.06 } },
    });
    assert.deepEqual(result.usage, { inputTokens: 157, outputTokens: 0 });
    assert.equal(result.timing.loadMs, null);
    assert.equal(result.timing.computeMs, null);
    assert.ok(result.timing.wallMs > 0);
    assert.equal(result.model, 'josev-test');
  });
});

test('noul uses probability of true with a threshold of 0.5', async () => {
  for (const [p, expected] of [[0, false], [0.49, false], [0.5, true], [1, true]]) {
    await withServer((req, res) => json(res, { answers: { flag: { type: 'noul', noul: p } } }), async baseUrl => {
      const result = await invokeJosev({ baseUrl, model: 'test', state: 'Synthetisch', questions: { flag: { type: 'noul', instructions: 'Trifft das zu?' } } });
      assert.deepEqual(result.answers.flag, { value: expected, probability: p, probabilities: null });
      assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null });
    });
  }
});

test('LLM baseline receives the same state and questions with strict boolean/enum schema', async () => {
  let received;
  await withServer((req, res, body) => {
    received = { url: req.url, body };
    json(res, {
      message: { role: 'assistant', content: JSON.stringify({ refund: true, team: 'billing' }) },
      done: true, prompt_eval_count: 201, eval_count: 15,
      load_duration: 10_000_000, prompt_eval_duration: 23_000_000, eval_duration: 75_000_000,
    });
  }, async baseUrl => {
    const result = await invokeLlm({ baseUrl, model: 'baseline-test', state, questions, keepAlive: -1 });
    assert.equal(received.url, '/api/chat');
    assert.equal(received.body.model, 'baseline-test');
    assert.deepEqual(JSON.parse(received.body.messages[1].content), { state, questions });
    assert.deepEqual(received.body.format, {
      type: 'object', properties: { refund: { type: 'boolean' }, team: { type: 'string', enum: ['billing', 'technical'] } },
      required: ['refund', 'team'], additionalProperties: false,
    });
    assert.equal(received.body.think, false);
    assert.equal(received.body.stream, false);
    assert.equal(received.body.keep_alive, -1);
    assert.equal(received.body.options.temperature, 0);
    assert.deepEqual(result.answers, {
      refund: { value: true, probability: null, probabilities: null },
      team: { value: 'billing', probability: null, probabilities: null },
    });
    assert.deepEqual(result.usage, { inputTokens: 201, outputTokens: 15 });
    assert.equal(result.timing.loadMs, 10);
    assert.equal(result.timing.computeMs, 98);
  });
});

test('Choice limit is checked before networking, accepting 26 and rejecting 27', async () => {
  let calls = 0;
  const makeCriteria = count => Object.fromEntries(Array.from({ length: count }, (_, i) => [`c${i}`, `Klasse ${i}`]));
  await withServer((req, res, body) => {
    calls += 1;
    json(res, { answers: { label: { type: 'choice', choice: 'c0', probabilities: Object.fromEntries(Object.keys(body.questions.label.criteria).map(key => [key, key === 'c0' ? 1 : 0])) } } });
  }, async baseUrl => {
    await assert.rejects(invokeJosev({ baseUrl, model: 'test', state, questions: { label: { type: 'choice', instructions: 'Wähle.', criteria: makeCriteria(27) } } }), { code: 'INVALID_REQUEST' });
    assert.equal(calls, 0);
    await assert.rejects(invokeLlm({ baseUrl, model: 'test', state, questions: { label: { type: 'choice', instructions: 'Wähle.', criteria: makeCriteria(27) } } }), { code: 'INVALID_REQUEST' });
    assert.equal(calls, 0);
    const result = await invokeJosev({ baseUrl, model: 'test', state, questions: { label: { type: 'choice', instructions: 'Wähle.', criteria: makeCriteria(26) } } });
    assert.equal(calls, 1);
    assert.equal(result.answers.label.value, 'c0');
  });
});

test('Josev rejects incomplete answers, wrong types, invalid choices and invalid distributions', async t => {
  const variants = [
    ['missing answer', data => { delete data.answers.refund; }],
    ['wrong question type', data => { data.answers.refund.type = 'choice'; }],
    ['string probability', data => { data.answers.refund.noul = '0.9'; }],
    ['probability above one', data => { data.answers.refund.noul = 1.1; }],
    ['negative probability', data => { data.answers.team.probabilities.billing = -0.1; }],
    ['unknown choice', data => { data.answers.team.choice = 'other'; }],
    ['missing probability', data => { delete data.answers.team.probabilities.technical; }],
    ['probabilities do not sum to one', data => { data.answers.team.probabilities.billing = 0.2; }],
    ['invalid confidence', data => { data.answers.team.confidence = 'high'; }],
  ];
  for (const [name, mutate] of variants) {
    await t.test(name, async () => {
      const data = responseData();
      mutate(data);
      await withServer((req, res) => json(res, data), async baseUrl => {
        await assert.rejects(invokeJosev({ baseUrl, model: 'test', state, questions }), { code: 'INVALID_RESPONSE' });
      });
    });
  }
});

test('LLM output must exactly match the requested decision schema', async t => {
  const invalid = [
    ['string boolean', { refund: 'true', team: 'billing' }],
    ['unknown choice', { refund: true, team: 'other' }],
    ['missing answer', { team: 'billing' }],
    ['extra answer', { refund: true, team: 'billing', explanation: 'extra' }],
  ];
  for (const [name, payload] of invalid) {
    await t.test(name, async () => {
      await withServer((req, res) => json(res, { message: { content: JSON.stringify(payload) } }), async baseUrl => {
        await assert.rejects(invokeLlm({ baseUrl, model: 'test', state, questions }), { code: 'INVALID_RESPONSE' });
      });
    });
  }
});

test('HTTP errors are useful without echoing upstream bodies or credentials', async () => {
  await withServer((req, res) => {
    res.writeHead(404);
    res.end('private-host.intern secret-key-xyz /srv/customer/private');
  }, async baseUrl => {
    await assert.rejects(invokeJosev({ baseUrl, model: 'test', apiKey: 'secret-key-xyz', state, questions }), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'UPSTREAM_HTTP');
      assert.equal(error.upstreamStatus, 404);
      assert.match(error.message, /systemone/);
      assert.doesNotMatch(error.message, /private-host|secret-key|customer|127\.0\.0\.1/);
      return true;
    });
  });
});

test('non-JSON and oversized successful HTTP responses are rejected', async () => {
  for (const oversized of [false, true]) {
    await withServer((req, res) => {
      res.writeHead(200, oversized ? { 'content-length': 2 * 1024 * 1024 } : {});
      res.end('<html>Not model JSON</html>');
    }, async baseUrl => {
      await assert.rejects(invokeJosev({ baseUrl, model: 'test', state, questions }), { code: 'INVALID_RESPONSE' });
    });
  }
});

test('an in-flight caller abort cancels the model request without leaking its reason', async () => {
  let received;
  const requestArrived = new Promise(resolve => { received = resolve; });
  await withServer(() => received(), async baseUrl => {
    const controller = new AbortController();
    const promise = invokeJosev({ baseUrl, model: 'test', state, questions, signal: controller.signal });
    await requestArrived;
    controller.abort(new Error('private-secret'));
    await assert.rejects(promise, error => error.code === 'ABORTED' && !error.message.includes('private-secret'));
  });
});

test('a slow service is aborted at the configured timeout', async () => {
  await withServer(() => {}, async baseUrl => {
    await assert.rejects(invokeLlm({ baseUrl, model: 'test', state, questions, timeoutMs: 30 }), { code: 'TIMEOUT', status: 504 });
  });
});

test('invalid base URLs fail safely without opening a connection', async () => {
  await assert.rejects(invokeJosev({ baseUrl: 'http://user:secret@internal.example', model: 'test', state, questions }), error => {
    assert.equal(error.code, 'CONFIG');
    assert.doesNotMatch(error.message, /secret|internal\.example/);
    return true;
  });
});

test('OpenAI comparison adapter uses chat completions with strict JSON schema and bearer key', async () => {
  let seen;
  await withServer((req, res, body) => {
    seen = { url: req.url, auth: req.headers.authorization, body };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ refund: true, team: 'billing' }) } }],
      usage: { prompt_tokens: 210, completion_tokens: 9 },
    }));
  }, async baseUrl => {
    const result = await invokeLlm({ provider: 'openai', baseUrl, model: 'gpt-test', apiKey: 'sk-test', keepAlive: '10m', state, questions });
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.auth, 'Bearer sk-test');
    assert.equal(seen.body.response_format.type, 'json_schema');
    assert.equal(seen.body.response_format.json_schema.strict, true);
    assert.equal(seen.body.keep_alive, undefined);
    assert.equal(seen.body.temperature, undefined);
    assert.deepEqual(result.answers.team.value, 'billing');
    assert.deepEqual(result.usage, { inputTokens: 210, outputTokens: 9 });
    await assert.rejects(invokeLlm({ provider: 'openai', baseUrl, model: 'gpt-test', state, questions }), { code: 'CONFIG' });
  });
});
