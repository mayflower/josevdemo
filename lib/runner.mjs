import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {invokeJosev, invokeLlm, ProviderError} from './providers.mjs';
import {executeTask, prepareTask, warmupTask, InputError} from './tasks.mjs';
import {isConfigured, publicConfig} from './config.mjs';

export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function tokenCost(usage, pricing) {
  if (!pricing || !Number.isFinite(usage?.inputTokens) || !Number.isFinite(usage?.outputTokens)) return null;
  return (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
}

export function metricsFor(results, totalWallMs, rate, warmup = null, pricing = null) {
  const measured = results.filter(result => Number.isFinite(result.latencyMs));
  const successful = results.filter(result => result.status === 'ok');
  const latencies = successful.map(result => result.latencyMs);
  const sum = key => results.reduce((total, result) => total + (result[key] || 0), 0);
  const sumTokens = key => {
    if (!measured.length || measured.some(result => !Number.isFinite(result.usage?.[key]))) return null;
    return measured.reduce((total, result) => total + result.usage[key], 0);
  };
  const graded = results.reduce((total, result) => total + (result.correct?.total || 0), 0);
  const correct = results.reduce((total, result) => total + (result.correct?.matched || 0), 0);
  // Token prices take precedence: they are the real per-request price. Without them,
  // cost falls back to measured runtime x resource rate.
  const cost = pricing
    ? results.length > 0 && results.every(result => Number.isFinite(result.cost)) ? results.reduce((total, result) => total + result.cost, 0) : null
    : Number.isFinite(rate) && totalWallMs !== null ? totalWallMs / 3_600_000 * rate : null;
  const complete = successful.length === results.length && results.length > 0;
  return {
    items: results.length, successful: successful.length, errors: results.length - successful.length,
    skipped: results.filter(result => result.skipped).length,
    decisions: sum('decisions'), correct, graded,
    exactMatches: successful.filter(result => result.correct && result.correct.matched === result.correct.total).length,
    totalWallMs, activeMs: measured.reduce((total, result) => total + result.latencyMs, 0),
    p50Ms: quantile(latencies, .5), p95Ms: quantile(latencies, .95), latencySamples: latencies.length,
    throughput: totalWallMs > 0 ? successful.length * 1000 / totalWallMs : null,
    cost, costPer1000: cost !== null && complete ? cost * 1000 / results.length : null,
    costBasis: pricing ? `Tokenkosten aus den gemeldeten Eingabe- und Ausgabetoken × Preis je 1 Mio. Token${pricing.note ? ' (' + pricing.note + ')' : ''}; Warm-up separat.`
      : Number.isFinite(rate) ? `Zeitkosten-Schätzung: Laufzeit × ${rate} je Stunde; Warm-up separat.` : 'Kein Preis und kein Ressourcensatz konfiguriert.',
    inputTokens: sumTokens('inputTokens'), outputTokens: sumTokens('outputTokens'),
    warmup, complete,
  };
}

export function prepareRun(selection, config) {
  if (!isConfigured(config.josev)) throw new InputError('Bitte OLLAMA_BASE_URL und JOSEV_MODEL in der serverseitigen .env konfigurieren.', 503);
  if (selection.options.mode === 'compare' && !isConfigured(config.llm)) throw new InputError('Für den Vergleich bitte LLM_MODEL und gegebenenfalls LLM_BASE_URL in .env konfigurieren.', 503);
  return {...selection, tasks: selection.items.map(item => prepareTask(selection.scenario.id, item, selection.options))};
}

function safeError(error) {
  if (error instanceof ProviderError || error instanceof InputError) return error.message;
  return 'Die Anfrage konnte nicht vollständig ausgewertet werden. Modellantwort und Serverkonfiguration prüfen.';
}

const abort = signal => { if (signal?.aborted) throw signal.reason || new DOMException('Abgebrochen', 'AbortError'); };

export async function runExperiment(plan, config, emit, signal, providers = {josev: invokeJosev, llm: invokeLlm}) {
  const runId = randomUUID();
  const {scenario, items, tasks, options} = plan;
  const lanes = [{id: 'josev', label: 'Josev', model: config.josev.model}];
  if (options.mode === 'compare') lanes.push({id: 'llm', label: 'Vergleichs-LLM', model: config.llm.model});
  await emit({type: 'run', runId, scenario: scenario.id, mode: options.mode, schedule: options.schedule,
    items, lanes, config: {...options, models: publicConfig(config)}, startedAt: new Date().toISOString(),
    costBasis: publicConfig(config).costBasis,
    taskDefinition: 'Gleiche Texte, Ausgangsoptionen und Entscheidungsstrategie; Banking-Finalisten entstehen je Modell. Synthetische Sollwerte bleiben außerhalb der Modellanfrage.'});
  const metrics = {};

  async function runLane(lane) {
    abort(signal);
    const laneConfig = config[lane.id];
    const invoke = payload => providers[lane.id]({...laneConfig, timeoutMs: config.timeoutMs, ...payload});
    let warmup = null;
    let fatalError = null;
    if (options.warmup) {
      await emit({type: 'phase', lane: lane.id, phase: 'warmup', message: 'Modell laden und mit einem separaten Kurztext aufwärmen …'});
      const start = performance.now();
      try {
        const response = await invoke({...warmupTask, signal});
        warmup = {ok: true, wallMs: performance.now() - start, usage: response.usage};
      } catch (error) {
        abort(signal);
        fatalError = safeError(error);
        warmup = {ok: false, wallMs: performance.now() - start, error: fatalError};
      }
    }
    abort(signal);
    await emit({type: 'phase', lane: lane.id, phase: fatalError ? 'error' : 'running', message: fatalError || 'Messung läuft. Jedes Ergebnis kommt direkt vom Modell.', warmup});
    const started = performance.now();
    let nextIndex = 0, lastCostElapsed = 0, consecutiveErrors = 0;
    const results = [];

    async function worker() {
      while (true) {
        abort(signal);
        if (fatalError) return;
        const index = nextIndex++;
        if (index >= items.length) return;
        const item = items[index];
        await emit({type: 'start', lane: lane.id, itemId: item.id, index});
        const itemStarted = performance.now();
        let result;
        try {
          const output = await executeTask(tasks[index], invoke, signal);
          result = {type: 'result', lane: lane.id, itemId: item.id, index, status: 'ok', ...output, latencyMs: performance.now() - itemStarted};
          consecutiveErrors = 0;
        } catch (error) {
          abort(signal);
          consecutiveErrors++;
          result = {type: 'result', lane: lane.id, itemId: item.id, index, status: 'error',
            values: {}, probabilities: {}, latencyMs: performance.now() - itemStarted,
            usage: {inputTokens: null, outputTokens: null},
            correct: tasks[index].expected ? {matched: 0, total: Object.values(tasks[index].expected).filter(value => value !== undefined).length} : null,
            error: safeError(error), code: error.code || 'ERROR', decisions: 0};
          if (['CONFIG', 'UNREACHABLE', 'TIMEOUT'].includes(error.code) || [401, 403, 404].includes(error.upstreamStatus) || consecutiveErrors >= 3) fatalError = result.error;
        }
        const elapsed = performance.now() - started;
        result.elapsedMs = elapsed;
        // Allocate each interval once; summing request latencies would overcharge concurrent work.
        result.cost = laneConfig.pricing ? tokenCost(result.usage, laneConfig.pricing)
          : Number.isFinite(laneConfig.costPerHour) ? (elapsed - lastCostElapsed) / 3_600_000 * laneConfig.costPerHour : null;
        lastCostElapsed = elapsed;
        results.push(result);
        await emit(result);
      }
    }

    await Promise.all(Array.from({length: Math.min(options.concurrency, items.length)}, worker));
    abort(signal);
    const totalWallMs = fatalError && !results.length ? null : performance.now() - started;
    const completedIndices = new Set(results.map(result => result.index));
    if (fatalError) {
      await emit({type: 'phase', lane: lane.id, phase: 'error', message: fatalError});
      for (let index = 0; index < items.length; index++) {
        if (completedIndices.has(index)) continue;
        const result = {type: 'result', lane: lane.id, itemId: items[index].id, index, status: 'error', skipped: true,
          values: {}, probabilities: {}, latencyMs: null, usage: {inputTokens: null, outputTokens: null}, cost: null,
          correct: tasks[index].expected ? {matched: 0, total: Object.values(tasks[index].expected).filter(value => value !== undefined).length} : null,
          error: `Nicht ausgeführt: ${fatalError}`, decisions: 0};
        results.push(result);
        await emit(result);
      }
    }
    const summary = metricsFor(results, totalWallMs, laneConfig.costPerHour, warmup, laneConfig.pricing);
    if (fatalError) summary.fatalError = fatalError;
    metrics[lane.id] = summary;
    await emit({type: 'lane_done', lane: lane.id, metrics: summary});
  }

  if (lanes.length > 1 && options.schedule === 'parallel') {
    await Promise.all(lanes.map(runLane));
  } else {
    if (lanes.length > 1) await emit({type: 'phase', lane: 'llm', phase: 'waiting', message: 'Startet nach Josev; beide Modelle nutzen dieselben Beispiele.'});
    for (const lane of lanes) await runLane(lane);
  }
  abort(signal);
  const comparisonValid = Boolean(metrics.josev?.complete && metrics.llm?.complete);
  const comparison = comparisonValid ? {
    speedup: metrics.llm.totalWallMs / metrics.josev.totalWallMs,
    costRatio: metrics.josev.cost > 0 && metrics.llm.cost !== null ? metrics.llm.cost / metrics.josev.cost : null,
    costSavingPercent: metrics.llm.cost > 0 && metrics.josev.cost !== null ? (1 - metrics.josev.cost / metrics.llm.cost) * 100 : null,
    qualityJosev: metrics.josev.graded ? metrics.josev.correct / metrics.josev.graded : null,
    qualityLlm: metrics.llm.graded ? metrics.llm.correct / metrics.llm.graded : null,
  } : null;
  await emit({type: 'done', runId, metrics, comparison, finishedAt: new Date().toISOString()});
  return {runId, metrics, comparison};
}
