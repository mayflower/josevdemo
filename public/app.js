'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const number = (value, maximumFractionDigits = 1) => new Intl.NumberFormat('de-DE', {maximumFractionDigits}).format(value);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const meta = {
    triage: {type: 'NOUL · 5 BINÄRE FRAGEN', title: 'Was braucht diese Nachricht?', description: 'Kündigung, Erstattung, Ärger, technischer Fehler, menschlicher Kontakt: fünf unabhängige Entscheidungen für jede Nachricht.', output: 'ENTSCHEIDUNGEN PRO NACHRICHT'},
    feed: {type: 'NOUL · SEMANTISCHER FILTER', title: 'Ein Kriterium. Der passende Feed.', description: 'Jeder Beitrag beantwortet dieselbe Frage. Passende Posts bleiben sichtbar, die übrigen wandern in die zweite Ablage.', output: 'SORTIERTE BEITRÄGE'},
    extract: {type: 'CHOICE · 5 FELDER', title: 'Der richtige Wert steht schon im Text.', description: 'Nummern, Beträge, Daten und Adressen werden als Kandidaten erkannt. Das Modell wählt die passenden Originalwerte oder „nicht vorhanden“.', output: 'AUSGEWÄHLTE ORIGINALWERTE'},
    documents: {type: 'CHOICE + NOUL · SEITENWEISE', title: 'Aus einem Stapel werden Dokumente.', description: 'Jede Seite erhält eine Dokumentart. Eine zweite Entscheidung erkennt, ob hier ein neues Dokument beginnt – auch bei gleicher Dokumentart.', output: 'ERKANNTE DOKUMENTE'},
    banking: {type: 'CHOICE · 77 KATEGORIEN', title: '77 Möglichkeiten. Eine passende Absicht.', description: 'Eine Nachricht wird genau einem Bankanliegen zugeordnet. Die deutschen Texte sind neu für diese Demo geschrieben.', output: 'ZUORDNUNG ZU 77 INTENTS'},
  };
  const questionNames = {cancellation: 'Kündigung', refund: 'Erstattung', angry: 'Verärgert', bug: 'Technischer Fehler', human: 'Person gewünscht'};
  const fieldNames = {invoice_number: 'Rechnungsnummer', total_due: 'Zahlbetrag', due_date: 'Fällig am', po_number: 'Bestellnummer', billing_email: 'Rechnungskontakt'};
  const state = {
    scenarios: [], bankingCategories: [], documentCategories: [], feedPresets: [], triageQuestions: {},
    config: null, scenario: 'triage', counts: {}, lanes: {}, running: false, replaying: false,
    controller: null, timers: [], events: [], runEvent: null, doneEvent: null, lastRealRun: null,
    concurrency: 1, toastTimer: null, runStarted: false, health: null, healthChecking: false,
  };

  function node(tag, className, text, attributes) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    if (attributes) for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }
  function append(parent, ...children) { parent.append(...children.filter(Boolean)); return parent; }
  function setText(selector, text) { const target = $(selector); if (target) target.textContent = text; }
  function currentScenario() { return state.scenarios.find(scenario => scenario.id === state.scenario); }
  function selectedCount() { return Math.min(Number($('#runCount').value) || 12, currentScenario()?.items.length || 12); }
  function selectedItems() { return currentScenario()?.items.slice(0, selectedCount()) || []; }
  function isBusy() { return state.running || state.replaying; }
  function itemFor(id) { return state.runEvent?.items.find(item => item.id === id) || currentScenario()?.items.find(item => item.id === id); }
  function categoryName(id, categories = state.bankingCategories) { return categories.find(category => category.id === id)?.label || String(id ?? 'Unbekannte Kategorie'); }
  function truncate(text, length = 165) { const value = String(text || ''); return value.length > length ? value.slice(0, length - 1).trimEnd() + '…' : value; }
  function duration(value) {
    if (!Number.isFinite(value)) return {value: '—', unit: ''};
    return value < 1000 ? {value: number(value, value < 10 ? 1 : 0), unit: 'ms'} : {value: number(value / 1000, 2), unit: 's'};
  }
  function durationText(value) { const formatted = duration(value); return `${formatted.value}${formatted.unit ? ' ' + formatted.unit : ''}`; }
  // US dollars are shown as US cents (1 $ = 100 ¢); euros stay as they are.
  function currencySymbol() { return state.config?.currency === 'USD' ? '¢' : '€'; }
  function money(value) { return state.config?.currency === 'USD' ? value * 100 : value; }
  function euro(value, digits = 4) { return Number.isFinite(value) ? number(money(value), digits) + ' ' + currencySymbol() : 'nicht konfiguriert'; }
  function percentile(values, percentileValue) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)];
  }
  function showToast(message) {
    clearTimeout(state.toastTimer);
    $('#toast').textContent = message;
    $('#toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200);
  }
  function showError(message) { $('#errorBanner').textContent = message; $('#errorBanner').hidden = !message; }
  function newLane(id) {
    return {id, phase: 'ready', results: [], pending: new Set(), metrics: null, message: '', lastItem: null, warmup: null};
  }
  function resetLanes() { state.lanes = {josev: newLane('josev'), llm: newLane('llm')}; }
  function resetView() {
    state.runStarted = false;
    state.runEvent = null;
    state.doneEvent = null;
    resetLanes();
    showError('');
    renderLanes();
    renderSummary();
    setRunStatus('Vorschau · keine Modellresultate');
    $('#replayButton').hidden = true;
  }
  function setRunStatus(message, running = false) {
    setText('#runStatus', message);
    $('#runStatus').classList.toggle('running', running);
  }

  function updateControls() {
    const busy = isBusy();
    const configured = Boolean(state.config?.josev?.configured);
    const compare = $('#runMode').value === 'compare';
    const baselineReady = Boolean(state.config?.llm?.configured);
    $('#runButton').disabled = busy || state.healthChecking || !currentScenario() || !configured || (compare && !baselineReady);
    $('#runButton span').textContent = state.running ? 'Messung läuft' : state.replaying ? 'Replay läuft' : compare ? 'Vergleich starten' : 'Josev starten';
    $('#stopButton').hidden = !busy;
    $('#stopButton').lastChild.textContent = state.replaying ? 'Replay stoppen' : 'Stoppen';
    for (const selector of ['#runCount', '#runMode', '#runSchedule', '#warmup']) $(selector).disabled = busy;
    $('#scenarioSelect').disabled = busy;
    $('#replayButton').disabled = busy;
    $('#runSchedule').disabled = busy || !compare;
    const concurrencyControl = $('#concurrency');
    if (concurrencyControl) concurrencyControl.disabled = busy;
    $('#scheduleNote').textContent = compare
      ? $('#runSchedule').value === 'parallel'
        ? 'Beide Modelle gleichzeitig' + (state.config?.sameServer ? ' auf demselben Ollama: Zeiten konkurrieren um dieselbe GPU.' : '. Die Server müssen getrennte Rechenressourcen nutzen.')
        : 'Ein Modell nach dem anderen. Geeignet für zwei Modelle auf derselben GPU.'
      : 'Josev entscheidet über die gewählten Beispiele. Einen LLM-Vergleich kannst du separat starten.';
    if (!busy) renderNotice();
    $('#comparisonStage').classList.toggle('single-lane', !compare);
    $('#lane-llm').classList.toggle('disabled-lane', !compare);
  }

  function renderNotice() {
    const notice = $('#notice');
    notice.replaceChildren();
    if (!state.config) { notice.hidden = true; return; }
    let message = '';
    if (!state.config.josev.configured) message = 'Die Beispieldaten sind bereit. Für echte Messungen muss die interne Ollama-Verbindung auf dem Server konfiguriert sein. ';
    else if ($('#runMode').value === 'compare' && !state.config.llm.configured) message = 'Josev ist konfiguriert. Für den Vergleich fehlt noch das LLM-Modell. Wähle „Nur Josev“ oder ergänze die Serverkonfiguration. ';
    if (message) {
      notice.append(document.createTextNode(message));
      const button = node('button', '', 'Konfiguration ansehen');
      button.type = 'button';
      button.addEventListener('click', openSettings);
      notice.append(button);
    }
    notice.hidden = !message;
  }

  function selectScenario(id) {
    if (isBusy() || !meta[id]) return;
    state.counts[state.scenario] = Number($('#runCount').value) || 12;
    state.scenario = id;
    $('#scenarioSelect').value = id === 'feed' ? 'feed:' + state.feedPreset : id;
    updateCountOptions();
    resetView();
    updateControls();
  }

  function updateCountOptions() {
    const total = currentScenario()?.items.length || 0;
    const select = $('#runCount');
    const target = state.counts[state.scenario] || (state.scenario === 'documents' ? total : 12);
    const values = [...new Set([6, 12, 24, 48, 77, 154].filter(value => value <= total).concat(total ? [total] : [12]))].sort((a, b) => a - b);
    select.replaceChildren();
    for (const value of values) {
      const label = `${value} ${state.scenario === 'documents' ? 'Seiten' : 'Beispiele'}${value === total ? ' · alle' : ''}`;
      select.append(node('option', '', label, {value}));
    }
    const nearest = values.includes(target) ? target : values.reduce((best, value) => Math.abs(value - target) < Math.abs(best - target) ? value : best, values[0]);
    select.value = String(nearest);
  }

  function liveMetrics(lane) {
    if (lane.metrics) return lane.metrics;
    const successful = lane.results.filter(result => result.status === 'ok');
    const latencies = successful.map(result => result.latencyMs).filter(Number.isFinite);
    const graded = lane.results.reduce((sum, result) => sum + (result.correct?.total || 0), 0);
    const correct = lane.results.reduce((sum, result) => sum + (result.correct?.matched || 0), 0);
    const costKnown = lane.results.length > 0 && lane.results.every(result => Number.isFinite(result.cost));
    const cost = costKnown ? lane.results.reduce((sum, result) => sum + result.cost, 0) : null;
    const elapsed = lane.results.reduce((maximum, result) => Math.max(maximum, result.elapsedMs || 0), 0);
    return {
      items: lane.results.length, successful: successful.length, errors: lane.results.length - successful.length,
      p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95), latencySamples: latencies.length,
      graded, correct, throughput: elapsed > 0 ? successful.length / (elapsed / 1000) : null,
      totalWallMs: elapsed || null, cost,
      costPer1000: null,
    };
  }

  function metric(value, unit, label, title) {
    const wrapper = node('div', 'metric');
    const display = node('div', 'metric-value');
    append(display, node('span', '', value), unit ? node('small', '', unit) : null);
    append(wrapper, display, node('span', 'metric-label', label));
    if (title) wrapper.title = title;
    return wrapper;
  }

  function renderLane(id, animationResult) {
    const lane = state.lanes[id];
    const element = $('#lane-' + id);
    const priorScroll = $('.results-scroll', element)?.scrollTop || 0;
    const oldSource = $('.pipeline-card', element)?.getBoundingClientRect();
    element.replaceChildren();
    for (const value of ['is-running', 'is-complete', 'is-cancelled', 'is-error']) element.classList.remove(value);
    element.classList.toggle('is-running', ['running', 'warmup'].includes(lane.phase));
    element.classList.toggle('is-complete', lane.phase === 'done');
    element.classList.toggle('is-cancelled', lane.phase === 'cancelled');
    element.classList.toggle('is-error', lane.phase === 'error');
    element.classList.toggle('disabled-lane', id === 'llm' && $('#runMode').value !== 'compare');
    const laneConfig = state.config?.[id];
    const header = node('header', 'lane-header');
    const identity = node('div', 'lane-identity');
    const names = node('div');
    const heading = node('h3', 'lane-heading', id === 'josev' ? 'Josev' : 'Vergleichs-LLM', {id: id === 'josev' ? 'josevHeading' : 'llmHeading'});
    append(heading, node('span', '', id === 'josev' ? 'DECISION MODEL' : 'GENERATIVES MODELL'));
    const modelLabel = state.runEvent?.lanes.find(entry => entry.id === id)?.model || laneConfig?.model || 'Modell noch nicht konfiguriert';
    append(names, heading, node('p', 'model-name', modelLabel, {title: modelLabel}));
    append(identity, node('div', 'model-icon', id === 'josev' ? 'J' : 'L'), names);
    const phaseLabels = {ready: 'Bereit', warmup: 'Warm-up', waiting: 'Wartet', running: state.replaying ? 'Replay' : 'Misst', done: 'Fertig', cancelled: 'Abgebrochen', error: 'Fehler'};
    const laneState = node('div', 'lane-state', null, {title: lane.message || ''});
    append(laneState, node('span', 'status-dot'), node('span', '', !state.runStarted && !laneConfig?.configured ? 'Nicht verbunden' : phaseLabels[lane.phase] || lane.phase));
    append(header, identity, laneState);
    const metrics = liveMetrics(lane);
    const median = duration(metrics.p50Ms);
    const metricRow = node('div', 'lane-metrics');
    const latencyTitle = Number.isFinite(metrics.p50Ms) ? `Median aus ${metrics.latencySamples ?? lane.results.filter(result => result.status === 'ok').length} erfolgreichen Beispielen. P95: ${durationText(metrics.p95Ms)}. Laufzeit pro Beispiel einschließlich aller Auswahlstufen.` : 'Wird aus tatsächlich eingegangenen erfolgreichen Ergebnissen berechnet.';
    const tokenPriced = Boolean(laneConfig?.pricing);
    const rateConfigured = tokenPriced || Number.isFinite(laneConfig?.costPerHour);
    const costShown = Number.isFinite(metrics.costPer1000) ? metrics.costPer1000 : metrics.cost;
    const costCaption = !rateConfigured ? 'Kosten · nicht konfiguriert' : Number.isFinite(metrics.costPer1000) ? 'Kosten / 1.000 Fälle' : lane.metrics ? (tokenPriced ? 'Tokenkosten · Lauf' : 'Zeitkosten · Lauf') : (tokenPriced ? 'Tokenkosten · bisher' : 'Zeitkosten · bisher');
    append(metricRow,
      metric(median.value, median.unit, 'Antwortzeit · Median', latencyTitle),
      metric(Number.isFinite(metrics.throughput) ? number(metrics.throughput, 2) : '—', '', 'Erfolgreiche Fälle / s', 'Erfolgreiche Beispiele geteilt durch die gemessene Gesamtlaufzeit. Warm-up separat.'),
      metric(Number.isFinite(costShown) ? number(money(costShown), money(costShown) < 1 ? 4 : 2) : '—', Number.isFinite(costShown) ? currencySymbol() : '', costCaption, metrics.costBasis || state.config?.costBasis || 'Ohne Ressourcensatz wird keine Kostenschätzung angezeigt.'),
    );
    const total = state.runEvent?.items.length || selectedCount();
    const progress = node('div', 'lane-progress', null, {role: 'progressbar', 'aria-label': `${id === 'josev' ? 'Josev' : 'LLM'}: bearbeitete Beispiele`, 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': metrics.items || 0});
    const progressFill = node('div', 'lane-progress-fill');
    progressFill.style.width = `${total ? (metrics.items || 0) / total * 100 : 0}%`;
    progress.append(progressFill);
    const progressLabels = node('div', 'lane-progress-label');
    const countLabel = state.runStarted ? `${metrics.successful || 0} / ${total} erfolgreich${metrics.errors ? ' · ' + metrics.errors + ' Fehler' : ''}` : `${total} ${state.scenario === 'documents' ? 'Seiten' : 'Beispiele'} bereit`;
    const quality = node('span', 'quality-indicator', metrics.graded ? `Referenz ${metrics.correct}/${metrics.graded}` : state.runStarted ? 'ohne Referenzwertung' : 'Referenz nach Lauf');
    quality.classList.toggle('has-score', metrics.graded > 0);
    quality.classList.toggle('low-score', metrics.graded > 0 && metrics.correct < metrics.graded);
    quality.title = metrics.graded ? `${number(metrics.correct / metrics.graded * 100, 1)} % der redaktionellen Einzel-Sollantworten getroffen. Fehler zählen mit. Kein unabhängiger Modell-Benchmark.` : 'Eigene Filterbedingungen und eigene Texte haben keine redaktionellen Sollantworten.';
    append(progressLabels, node('span', '', countLabel), quality);
    append(element, header, metricRow, progress, progressLabels);
    if (!state.runStarted) renderPreview(element, id);
    else renderResults(element, lane);
    if (lane.metrics) {
      const footer = node('div', 'lane-final-note');
      append(footer, node('span', '', `Gesamt ${durationText(metrics.totalWallMs)} · P95 ${durationText(metrics.p95Ms)}`), node('strong', '', `${metrics.successful} erfolgreich${metrics.errors ? ' · ' + metrics.errors + ' Fehler' : ''}`));
      element.append(footer);
      const costLine = metrics.cost !== null && metrics.cost !== undefined ? (tokenPriced ? `Lauf: ${euro(metrics.cost, 6)} aus ${number(metrics.inputTokens ?? 0, 0)} Eingabe- und ${number(metrics.outputTokens ?? 0, 0)} Ausgabetoken · ${number(money(laneConfig.pricing.inputPerMTok), 4)} / ${number(money(laneConfig.pricing.outputPerMTok), 4)} ${currencySymbol()} je 1 Mio. Token${laneConfig.pricing.note ? ' (' + laneConfig.pricing.note + ')' : ''}. Warm-up separat.` : `Lauf: ${euro(metrics.cost, 6)} geschätzt · ${number(money(laneConfig?.costPerHour || 0), 4)} ${currencySymbol()}/h. Warm-up separat.`) : rateConfigured ? 'Keine gemessene Laufzeit verfügbar; keine Kostenhochrechnung. Warm-up separat.' : 'Kein Ressourcensatz hinterlegt; es wird kein Preis angenommen.';
      const tokenLine = Number.isFinite(metrics.inputTokens) && Number.isFinite(metrics.outputTokens) ? ` Token: ${number(metrics.inputTokens, 0)} Eingabe · ${number(metrics.outputTokens, 0)} Ausgabe.` : '';
      element.append(node('p', 'lane-cost-note', tokenPriced ? costLine : costLine + tokenLine));
    }
    const resultsScroll = $('.results-scroll', element);
    if (resultsScroll && !['triage', 'feed', 'extract'].includes(state.scenario)) resultsScroll.scrollTop = priorScroll;
    if (animationResult && animationResult.status === 'ok') animateArrival(element, oldSource, animationResult);
  }

  function renderLanes() { renderLane('josev'); renderLane('llm'); }

  function renderPreview(parent, id) {
    const body = node('div', 'lane-body');
    const heading = node('div', 'lane-body-heading');
    append(heading, node('span', '', 'EINGANG · DATENVORSCHAU'), node('span', 'body-indicator', 'noch keine Klassifikation'));
    body.append(heading);
    const cards = node('div', 'preview-cards');
    const items = selectedItems().slice(0, 3);
    for (const [index, item] of items.entries()) {
      const card = node('article', 'preview-card');
      const cardHeader = node('div', 'preview-card-header');
      append(cardHeader, node('strong', '', item.title || `Beispiel ${index + 1}`), node('span', '', state.scenario === 'documents' ? `SEITE ${item.pageNumber || index + 1}` : String(index + 1).padStart(2, '0')));
      append(card, cardHeader, node('p', '', truncate(item.text, 235)));
      cards.append(card);
    }
    if (!items.length) {
      for (let index = 0; index < 3; index++) {
        const skeleton = node('div', 'skeleton-card');
        append(skeleton, node('div', 'skeleton-line short'), node('div', 'skeleton-line'), node('div', 'skeleton-line'));
        cards.append(skeleton);
      }
    }
    append(body, cards, node('div', 'preview-foot', id === 'llm' && $('#runMode').value !== 'compare' ? 'Vergleichs-LLM ist für diesen Lauf ausgeschaltet.' : 'Ergebnisse erscheinen nach dem Start der Messung.'));
    parent.append(body);
  }

  function renderResults(parent, lane) {
    const body = node('div', 'lane-body');
    const pipeline = node('div', 'pipeline');
    const processing = ['running', 'warmup'].includes(lane.phase);
    const caption = lane.phase === 'warmup' ? 'WARM-UP · NICHT GEWERTET' : state.replaying ? 'REPLAY · GEMESSENE ZEITEN' : lane.phase === 'waiting' ? 'IN DER WARTESCHLANGE' : processing ? 'MODELL ENTSCHEIDET' : 'EINGANG';
    const pipelineCard = node('div', `pipeline-card${processing ? ' processing' : ''}`);
    const activeItemId = [...lane.pending][0];
    const activeItem = activeItemId && itemFor(activeItemId);
    const waitingText = lane.phase === 'warmup' ? 'Das Modell wird geladen und mit einem separaten Kurztext aufgewärmt.' : lane.phase === 'waiting' ? 'Die gleichen Beispiele starten, sobald Josev vollständig gemessen wurde.' : lane.phase === 'done' ? 'Alle Beispiele sind bearbeitet.' : lane.phase === 'cancelled' ? 'Lauf gestoppt. Bereits eingegangene Ergebnisse bleiben sichtbar.' : lane.phase === 'error' ? lane.message || 'Der Modellaufruf konnte nicht vollständig ausgeführt werden.' : state.replaying ? 'Wiedergabe wartet auf das nächste gemessene Ergebnis.' : 'Warte auf die nächste Modellantwort …';
    pipelineCard.append(node('p', '', activeItem ? activeItem.text : waitingText));
    append(pipeline, node('span', 'pipeline-caption', caption), pipelineCard, node('span', 'pipeline-arrow', '↓', {'aria-hidden': 'true'}));
    const heading = node('div', 'results-heading');
    append(heading, node('span', '', meta[state.scenario].output), node('span', '', lane.pending.size > 1 ? `${lane.pending.size} Anfragen aktiv` : state.replaying ? '1:1 wiedergegeben' : 'echte Ergebnisse'));
    const scroll = node('div', 'results-scroll');
    const good = lane.results.filter(result => result.status === 'ok');
    const bad = lane.results.filter(result => result.status !== 'ok');
    if (state.scenario === 'feed') renderFeed(scroll, good);
    else if (state.scenario === 'documents') renderDocuments(scroll, good);
    else if (state.scenario === 'banking') renderBanking(scroll, good);
    else for (const result of [...good].reverse()) scroll.append(state.scenario === 'extract' ? extractionCard(result) : triageCard(result));
    for (const result of bad) scroll.append(errorCard(result));
    if (!lane.results.length && !['feed', 'banking'].includes(state.scenario)) scroll.append(emptyState());
    append(body, pipeline, heading, scroll);
    parent.append(body);
  }

  function emptyState(text = 'Das nächste Modellresultat landet hier.') {
    return append(node('div', 'empty-results'), node('span', 'empty-symbol', '↘', {'aria-hidden': 'true'}), node('span', '', text));
  }

  function basicResultCard(result, extraClass = '') {
    const item = itemFor(result.itemId) || {};
    const card = node('article', `result-card ${extraClass}`.trim(), null, {'data-item-id': result.itemId});
    const header = node('div', 'result-card-header');
    append(header, node('strong', '', item.title || `Beispiel ${result.index + 1}`, {title: item.title || ''}), node('span', 'item-time', result.skipped ? 'nicht ausgeführt' : durationText(result.latencyMs)));
    append(card, header, node('p', '', item.text || '', {title: item.text || ''}));
    return card;
  }

  function triageCard(result) {
    const card = basicResultCard(result);
    const item = itemFor(result.itemId) || {};
    const badges = node('div', 'triage-badges');
    for (const [key, name] of Object.entries(questionNames)) {
      const value = result.values?.[key];
      const badge = node('span', `decision-badge${value === true ? ' yes' : ''}`);
      const mismatch = item.expected?.[key] !== undefined && item.expected[key] !== value;
      badge.classList.toggle('incorrect', mismatch);
      append(badge, node('span', 'decision-symbol', value === true ? '✓' : value === false ? '−' : '?'), node('span', '', name));
      badge.title = `${name}: ${value === true ? 'Ja' : value === false ? 'Nein' : 'keine gültige Antwort'}${Number.isFinite(result.probabilities?.[key]) ? ' · P(Ja): ' + number(result.probabilities[key] * 100, 1) + ' %' : ''}${mismatch ? ' · Referenz: ' + (item.expected[key] ? 'Ja' : 'Nein') : ''}`;
      badges.append(badge);
    }
    card.append(badges);
    if (result.correct && result.correct.matched < result.correct.total) card.append(node('div', 'reference-mismatch', `${result.correct.total - result.correct.matched} Abweichung(en) von der Referenz`));
    return card;
  }

  function renderFeed(parent, results) {
    const columns = node('div', 'feed-columns');
    for (const matching of [true, false]) {
      const filtered = results.filter(result => result.values?.match === matching);
      const bin = node('section', `feed-bin${matching ? '' : ' hidden-bin'}`);
      const header = node('div', 'feed-bin-header');
      append(header, node('span', '', matching ? '✓ Passt zum Filter' : '− Ausblenden'), node('b', '', filtered.length));
      bin.append(header);
      for (const result of [...filtered].reverse()) {
        const card = basicResultCard(result);
        if (Number.isFinite(result.probabilities?.match)) card.title = `P(Ja): ${number(result.probabilities.match * 100, 1)} %`;
        if (result.correct && result.correct.matched < result.correct.total) card.append(node('div', 'reference-mismatch', 'Referenz weicht ab'));
        bin.append(card);
      }
      if (!filtered.length) bin.append(emptyState(matching ? 'Passende Beiträge erscheinen hier.' : 'Die übrigen Beiträge erscheinen hier.'));
      columns.append(bin);
    }
    parent.append(columns);
  }

  function highlightedText(text, values) {
    const wrapper = node('div', 'extract-source');
    const source = String(text || '');
    const terms = [...new Set(Object.values(values || {}).filter(value => typeof value === 'string' && value !== 'none' && value.length > 0))];
    const spans = [];
    for (const term of terms) {
      let from = 0;
      while (from < source.length) {
        const at = source.indexOf(term, from);
        if (at < 0) break;
        spans.push({start: at, end: at + term.length});
        from = at + term.length;
      }
    }
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    let cursor = 0;
    for (const span of spans) {
      if (span.start < cursor) continue;
      wrapper.append(document.createTextNode(source.slice(cursor, span.start)), node('mark', '', source.slice(span.start, span.end)));
      cursor = span.end;
    }
    wrapper.append(document.createTextNode(source.slice(cursor)));
    return wrapper;
  }

  function extractionCard(result) {
    const card = basicResultCard(result);
    $('p', card)?.remove();
    const item = itemFor(result.itemId) || {};
    card.append(highlightedText(item.text, result.values));
    const fields = node('div', 'extracted-fields');
    for (const [key, label] of Object.entries(fieldNames)) {
      const value = result.values?.[key];
      const absent = value === 'none';
      const field = node('div', 'extracted-field');
      field.classList.toggle('incorrect', item.expected?.[key] !== undefined && item.expected[key] !== value);
      append(field, node('span', 'extracted-field-label', label), node('span', `extracted-field-value${absent ? ' absent' : ''}`, absent ? 'Nicht vorhanden' : value || 'Keine Antwort'));
      if (result.deterministicFields?.includes(key)) field.title = 'Kein Kandidat im Text gefunden. Das gemeinsame Vorverarbeiten setzt dieses Feld auf „nicht vorhanden“; keine Modellentscheidung.';
      else if (Number.isFinite(result.probabilities?.[key])) field.title = `P(gewählte Option): ${number(result.probabilities[key] * 100, 1)} %`;
      fields.append(field);
    }
    card.append(fields);
    return card;
  }

  function renderDocuments(parent, results) {
    let previousBatch = null;
    let group = null;
    let groupNumber = 0;
    let pageContainer = null;
    const ordered = [...results].sort((a, b) => a.index - b.index);
    for (const result of ordered) {
      const item = itemFor(result.itemId) || {};
      const batch = item.batchId || 'stapel';
      if (batch !== previousBatch) {
        parent.append(node('div', 'document-packet-title', `${String(batch).replace(/[-_]/g, ' ').toLocaleUpperCase('de')}`));
        previousBatch = batch;
        group = null;
      }
      if (!group || result.values?.new_document === true) {
        groupNumber++;
        group = node('div', 'document-group');
        const header = node('div', 'document-group-heading');
        append(header, node('span'), node('strong', '', `Dokument ${String(groupNumber).padStart(2, '0')}${result.values?.new_document === false ? ' · sichtbare Fortsetzung' : ''}`));
        pageContainer = node('div', 'document-pages');
        append(group, header, pageContainer);
        parent.append(group);
      }
      const page = node('article', 'document-page', null, {'data-item-id': result.itemId});
      page.classList.toggle('reference-diff', Boolean(result.correct && result.correct.matched < result.correct.total));
      append(page, node('strong', '', `Seite ${item.pageNumber || result.index + 1}`), node('p', '', item.text || '', {title: item.text || ''}), node('span', 'document-page-category', categoryName(result.values?.category, state.documentCategories)), node('span', 'document-boundary', result.values?.new_document ? 'NEUES DOKUMENT' : 'FORTSETZUNG'));
      page.title = `${item.title || 'Seite'} · ${durationText(result.latencyMs)}${result.correct && result.correct.matched < result.correct.total ? ' · Referenzabweichung' : ''}`;
      pageContainer.append(page);
    }
  }

  function renderBanking(parent, results) {
    for (const result of [...results].reverse().slice(0, 3)) {
      const card = basicResultCard(result, 'banking-result');
      const label = node('span', 'intent-label', categoryName(result.values?.intent));
      label.title = result.probabilityScope || 'Auswahl im Finale aus drei Kandidaten';
      card.append(label);
      if (result.correct && result.correct.matched < result.correct.total) card.append(node('div', 'reference-mismatch', 'Referenz: ' + categoryName(itemFor(result.itemId)?.expected?.intent)));
      parent.append(card);
    }
    const grid = node('div', 'banking-grid', null, {'aria-label': 'Alle 77 möglichen Bankanliegen; hervorgehoben sind bereits ausgewählte Kategorien.'});
    for (const [index, category] of state.bankingCategories.entries()) {
      const count = results.filter(result => result.values?.intent === category.id).length;
      const cell = node('div', `intent-cell${count ? ' has-results' : ''}`, null, {'data-intent-id': category.id, title: `${category.label}: ${category.description} · ${count} zugeordnet`});
      append(cell, node('span', '', String(index + 1).padStart(2, '0')), node('strong', '', category.label), count ? node('em', '', count) : null);
      grid.append(cell);
    }
    parent.append(grid);
  }

  function errorCard(result) {
    const card = basicResultCard(result, 'error-result');
    const text = $('p', card);
    text.textContent = result.error || 'Die Modellantwort konnte nicht ausgewertet werden.';
    text.removeAttribute('title');
    return card;
  }

  function animateArrival(laneElement, sourceRect, result) {
    if (reducedMotion.matches || !Element.prototype.animate) return;
    const targets = $$('[data-item-id]', laneElement);
    const target = state.scenario === 'banking'
      ? $$('[data-intent-id]', laneElement).find(element => element.dataset.intentId === result.values?.intent)
      : targets.find(element => element.dataset.itemId === result.itemId);
    if (!target) return;
    const targetRect = target.getBoundingClientRect();
    const laneRect = laneElement.getBoundingClientRect();
    const visible = targetRect.top >= laneRect.top && targetRect.top < Math.min(window.innerHeight, laneRect.bottom) && targetRect.bottom > 0;
    if (!visible) {
      const recent = targets.find(element => element.dataset.itemId === result.itemId);
      recent?.animate([{transform: 'translateY(-7px)', opacity: .2}, {transform: 'translateY(0)', opacity: 1}], {duration: 360, easing: 'cubic-bezier(.2,.8,.2,1)'});
      return;
    }
    target.animate([{backgroundColor: state.lanes[result.lane]?.id === 'josev' ? '#dfcaff' : '#cbe2f7', transform: 'scale(.97)'}, {backgroundColor: getComputedStyle(target).backgroundColor, transform: 'scale(1)'}], {duration: 550, easing: 'ease-out'});
    if (!sourceRect || sourceRect.width === 0) return;
    const flying = node('div', 'flying-card', truncate(itemFor(result.itemId)?.text, 88));
    flying.style.left = `${sourceRect.left}px`;
    flying.style.top = `${sourceRect.top}px`;
    flying.style.width = `${Math.min(sourceRect.width, 290)}px`;
    flying.style.height = `${Math.min(sourceRect.height, 51)}px`;
    document.body.append(flying);
    const animation = flying.animate([
      {transform: 'translate(0,0) scale(1)', opacity: .8},
      {transform: `translate(${targetRect.left - sourceRect.left}px,${targetRect.top - sourceRect.top}px) scale(${Math.min(1, targetRect.width / Math.min(sourceRect.width, 290))})`, opacity: 0},
    ], {duration: 440, easing: 'cubic-bezier(.24,.74,.28,1)', fill: 'forwards'});
    animation.finished.finally(() => flying.remove());
  }

  function renderSummary() {
    const done = state.doneEvent;
    const first = done?.metrics?.josev;
    const second = done?.metrics?.llm;
    const comparable = first?.complete && second?.complete;
    setText('#speedRatio', '—');
    setText('#speedLabel', 'Gesamtlaufzeit im Vergleich');
    setText('#costRatio', '—');
    setText('#costLabel', 'Geschätzte Kosten im Vergleich');
    if (!comparable) {
      setText('#summaryNote', state.replaying ? 'Replay der gemessenen Zeiten · keine neue Modellanfrage.' : done && (!first?.complete || second && !second.complete) ? 'Mit unvollständigen Läufen wird kein Geschwindigkeits- oder Kostenverhältnis berechnet.' : 'Verhältnisse erscheinen nach einem vollständigen Vergleich.');
      return;
    }
    const ratio = done.comparison?.speedup ?? second.totalWallMs / first.totalWallMs;
    if (Number.isFinite(ratio) && ratio > 0) {
      setText('#speedRatio', number(ratio >= 1 ? ratio : 1 / ratio, 2) + '×');
      setText('#speedLabel', ratio >= 1 ? 'Josev schneller · Gesamtlauf' : 'LLM schneller · Gesamtlauf');
    }
    const savings = done.comparison?.costSavingPercent ?? (second.cost > 0 && Number.isFinite(first.cost) ? (1 - first.cost / second.cost) * 100 : null);
    if (Number.isFinite(savings)) {
      setText('#costRatio', number(Math.abs(savings), 1) + '%');
      setText('#costLabel', savings >= 0 ? 'geringere Kosten mit Josev' : 'höhere Kosten mit Josev');
    } else setText('#costLabel', 'Kostenvergleich nicht verfügbar');
    const qualityNote = first.graded && second.graded ? `Referenztreffer: Josev ${number(first.correct / first.graded * 100, 1)} % · LLM ${number(second.correct / second.graded * 100, 1)} %.` : 'Für diese Eingaben liegt keine Referenzwertung vor.';
    setText('#summaryNote', `${qualityNote} Kosten geschätzt; Warm-up separat.`);
  }

  function handleEvent(event, record = true) {
    if (!event || typeof event.type !== 'string') return;
    if (record) state.events.push(event);
    if (event.type === 'run') {
      state.runEvent = event;
      state.runStarted = true;
      state.doneEvent = null;
      resetLanes();
      for (const lane of event.lanes || []) state.lanes[lane.id].phase = 'waiting';
      renderLanes();
      renderSummary();
      return;
    }
    const lane = event.lane && state.lanes[event.lane];
    if (event.type === 'phase' && lane) {
      lane.phase = event.phase;
      lane.message = event.message || '';
      if (event.warmup) lane.warmup = event.warmup;
      renderLane(event.lane);
      setRunStatus(state.replaying ? 'Replay · gemessene Zeiten' : `${event.lane === 'josev' ? 'Josev' : 'LLM'} · ${event.phase === 'warmup' ? 'Warm-up' : event.phase === 'waiting' ? 'wartet' : event.phase === 'error' ? 'Fehler' : 'Messung läuft'}`, true);
    } else if (event.type === 'start' && lane) {
      lane.pending.add(event.itemId);
      lane.lastItem = event.itemId;
      if (lane.phase !== 'error') lane.phase = 'running';
      renderLane(event.lane);
    } else if (event.type === 'result' && lane) {
      lane.pending.delete(event.itemId);
      lane.lastItem = event.itemId;
      if (!lane.results.some(result => result.itemId === event.itemId)) lane.results.push(event);
      renderLane(event.lane, event);
      const doneCount = Object.values(state.lanes).reduce((sum, item) => sum + item.results.length, 0);
      const expectedCount = (state.runEvent?.items.length || 0) * (state.runEvent?.lanes.length || 1);
      setRunStatus(`${state.replaying ? 'Replay' : 'Messung'} · ${doneCount} / ${expectedCount} bearbeitet`, true);
      $('#exportButton').disabled = false;
    } else if (event.type === 'lane_done' && lane) {
      lane.metrics = event.metrics;
      lane.phase = event.metrics.errors ? 'error' : 'done';
      lane.message = event.metrics.fatalError || '';
      lane.pending.clear();
      renderLane(event.lane);
    } else if (event.type === 'done') {
      state.doneEvent = event;
      for (const [id, metrics] of Object.entries(event.metrics || {})) {
        state.lanes[id].metrics = metrics;
        state.lanes[id].phase = metrics.errors ? 'error' : 'done';
        state.lanes[id].pending.clear();
        renderLane(id);
      }
      renderSummary();
      const errors = Object.values(event.metrics || {}).reduce((sum, metrics) => sum + (metrics.errors || 0), 0);
      setRunStatus(`${state.replaying ? 'Replay beendet' : 'Messung abgeschlossen'}${errors ? ' · ' + errors + ' Fehler' : ''}`);
      if (record) {
        state.lastRealRun = {runEvent: state.runEvent, events: [...state.events], doneEvent: event};
        $('#replayButton').hidden = !(event.metrics?.josev?.complete && event.metrics?.llm?.complete);
      }
      $('#exportButton').disabled = false;
    } else if (event.type === 'error') {
      showError(event.message || 'Der Lauf konnte nicht abgeschlossen werden.');
      setRunStatus('Messung mit Fehler beendet');
    }
  }

  async function jsonResponse(response) {
    let body;
    try { body = await response.json(); } catch { throw new Error(`Der Server lieferte keine gültige JSON-Antwort (HTTP ${response.status}).`); }
    if (!response.ok) throw new Error(body.message || body.error || `Serverfehler: HTTP ${response.status}`);
    return body;
  }

  async function startRun() {
    if (isBusy() || $('#runButton').disabled) return;
    state.running = true;
    state.events = [];
    state.runEvent = null;
    state.doneEvent = null;
    state.lastRealRun = null;
    state.runStarted = false;
    state.controller = new AbortController();
    resetLanes();
    renderLanes();
    renderSummary();
    showError('');
    $('#notice').hidden = true;
    $('#exportButton').disabled = true;
    $('#replayButton').hidden = true;
    setRunStatus('Verbindung zur Messung wird aufgebaut …', true);
    updateControls();
    const request = {
      scenario: state.scenario, count: selectedCount(), mode: $('#runMode').value,
      schedule: $('#runSchedule').value, warmup: $('#warmup').checked,
      concurrency: state.concurrency, feedPreset: state.feedPreset || 'ai_business',
    };
    let gotDone = false;
    try {
      const response = await fetch('/api/run', {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/x-ndjson'}, body: JSON.stringify(request), signal: state.controller.signal});
      if (!response.ok) { await jsonResponse(response); return; }
      if (!response.body) throw new Error('Dieser Browser unterstützt das Streamen der Ergebnisse nicht. Bitte einen aktuellen Browser verwenden.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const consumeLine = line => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch { throw new Error('Der Ergebnisstrom enthält eine ungültige Nachricht. Die bisherigen Ergebnisse bleiben verfügbar.'); }
        handleEvent(event);
        if (event.type === 'done') gotDone = true;
      };
      while (true) {
        const {value, done} = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), {stream: !done});
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          consumeLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
        if (buffer.length > 8_000_000) throw new Error('Der Ergebnisstrom ist unerwartet groß. Der Lauf wurde zum Schutz des Browsers gestoppt.');
        if (done) break;
      }
      if (buffer.trim()) consumeLine(buffer);
      if (!gotDone && !state.controller.signal.aborted) throw new Error('Die Verbindung endete vor dem Abschluss des Laufs. Bereits eingegangene Ergebnisse bleiben sichtbar.');
    } catch (error) {
      if (state.controller?.signal.aborted || error.name === 'AbortError') {
        state.events.push({type: 'client_abort', at: new Date().toISOString(), message: 'Lauf im Browser abgebrochen.'});
        for (const lane of Object.values(state.lanes)) if (!['done', 'error'].includes(lane.phase)) { lane.phase = 'cancelled'; lane.pending.clear(); }
        setRunStatus('Abgebrochen · Teilergebnisse erhalten');
      } else {
        showError(error.message || 'Die Messung konnte nicht gestartet werden.');
        setRunStatus('Messung konnte nicht abgeschlossen werden');
        for (const lane of Object.values(state.lanes)) if (!['done', 'error'].includes(lane.phase)) { lane.phase = 'error'; lane.message = error.message; lane.pending.clear(); }
        state.controller?.abort();
      }
      renderLanes();
    } finally {
      state.running = false;
      state.controller = null;
      if (state.events.some(event => event.type === 'result')) $('#exportButton').disabled = false;
      updateControls();
    }
  }

  function stopRun() {
    if (state.replaying) {
      for (const timer of state.timers) clearTimeout(timer);
      state.timers = [];
      state.replaying = false;
      for (const lane of Object.values(state.lanes)) if (!['done', 'error'].includes(lane.phase)) { lane.phase = 'cancelled'; lane.pending.clear(); }
      renderLanes();
      setRunStatus('Replay gestoppt · Originalmessung ist exportierbar');
      updateControls();
    } else if (state.controller) state.controller.abort();
  }

  function replayRun() {
    if (isBusy() || !state.lastRealRun) return;
    const original = state.lastRealRun;
    if (!original.doneEvent.metrics?.josev?.complete || !original.doneEvent.metrics?.llm?.complete) return;
    state.replaying = true;
    state.timers = [];
    showError('');
    $('#notice').replaceChildren(node('strong', '', 'Replay der gemessenen Zeiten. '), document.createTextNode('Beide Läufe starten visuell bei null. Die Ergebnisse erscheinen nach ihren originalen, servergemessenen Zeitabständen. Es wird kein Modell erneut aufgerufen.'));
    $('#notice').hidden = false;
    handleEvent(original.runEvent, false);
    for (const id of ['josev', 'llm']) handleEvent({type: 'phase', lane: id, phase: 'running', message: 'Wiedergabe eines abgeschlossenen Laufs.'}, false);
    setRunStatus('Replay · gemessene Zeiten', true);
    updateControls();
    for (const event of original.events.filter(event => event.type === 'result')) {
      if (!Number.isFinite(event.elapsedMs)) continue;
      state.timers.push(setTimeout(() => handleEvent(event, false), Math.max(0, event.elapsedMs)));
    }
    let lastAt = 0;
    for (const [id, metrics] of Object.entries(original.doneEvent.metrics)) {
      const at = Math.max(0, metrics.totalWallMs || 0);
      lastAt = Math.max(lastAt, at);
      state.timers.push(setTimeout(() => handleEvent({type: 'lane_done', lane: id, metrics}, false), at + 5));
    }
    state.timers.push(setTimeout(() => {
      handleEvent(original.doneEvent, false);
      state.replaying = false;
      state.timers = [];
      updateControls();
      $('#notice').replaceChildren(node('strong', '', 'Replay beendet. '), document.createTextNode('Die angezeigten Metriken und der JSON-Export gehören weiterhin zur Originalmessung.'));
      $('#notice').hidden = false;
    }, lastAt + 25));
  }

  function exportRun() {
    const events = state.lastRealRun?.events || state.events;
    if (!events.length) return;
    const runEvent = events.find(event => event.type === 'run');
    const content = {format: 'josev-decision-lab/1', exportedAt: new Date().toISOString(), dataNote: 'Synthetische deutsche Demonstrationsdaten. Metriken stammen aus realen Serverereignissen, Kosten sind konfigurationsabhängige Schätzungen.', config: state.config, events};
    const blob = new Blob([JSON.stringify(content, null, 2)], {type: 'application/json;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const link = node('a', '', '', {href: url, download: `josev-${runEvent?.scenario || state.scenario}-${String(runEvent?.runId || Date.now()).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36)}.json`});
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Originalereignisse und Messwerte als JSON exportiert.');
  }

  function settingsRow(label, value) { return append(node('div', 'settings-row'), node('span', '', label), node('strong', '', value)); }
  function renderSettings() {
    const parent = $('#settingsContent');
    parent.replaceChildren();
    parent.append(node('p', 'dialog-copy', 'Die Webanwendung spricht über ihren Server mit eurem internen Ollama. Modelle, Endpunkte und Kostensätze werden dort in der .env-Datei hinterlegt. Zugangsdaten gehören nicht in den Browser.'));
    for (const id of ['josev', 'llm']) {
      const config = state.config?.[id];
      const card = node('section', 'settings-card');
      const heading = node('h3', '', id === 'josev' ? 'Josev · Decision Model' : 'Vergleichs-LLM');
      const status = node('span', 'settings-status');
      append(status, node('span', 'status-dot ' + (state.health?.[id]?.ok ? 'ok' : '')), node('span', '', state.health?.[id]?.ok ? 'erreichbar' : config?.configured ? 'konfiguriert' : 'offen'));
      heading.append(status);
      append(card, heading, settingsRow('Modell', config?.model || 'nicht hinterlegt'), settingsRow('Preis', config?.pricing ? `${euro(config.pricing.inputPerMTok, 4)} Eingabe / ${euro(config.pricing.outputPerMTok, 4)} Ausgabe je 1 Mio. Token` : Number.isFinite(config?.costPerHour) ? euro(config.costPerHour, 4) + ' / h' : 'nicht konfiguriert'));
      if (state.health?.[id]?.message) card.append(node('p', '', state.health[id].message));
      parent.append(card);
    }
    const setup = node('section', 'settings-card');
    append(setup, node('h3', '', 'Verbindung konfigurieren'), node('p', '', 'Basis-URL und exakte Ollama-Modellnamen eintragen. Danach den Anwendungsserver neu starten und oben „Verbindung prüfen“ wählen.'), node('pre', '', 'OLLAMA_BASE_URL=http://euer-ollama:11434\nJOSEV_MODEL=josev-2b\nLLM_MODEL=euer-vergleichsmodell\n\n# Bei getrennten Ressourcen optional:\nLLM_BASE_URL=http://euer-llm-ollama:11434'));
    setup.append(node('p', '', 'Josev benötigt den Decision-Endpunkt /v1/systemone. Ein gewöhnlicher Chat-Endpunkt ersetzt dieses Protokoll nicht. Details zur passenden Ollama-Version stehen in der mitgelieferten README.'));
    parent.append(setup);
    const costs = node('section', 'settings-card');
    append(costs, node('h3', '', 'Kostenschätzung'), node('p', '', state.config?.costBasis || 'Gemessene Laufzeit × Ressourcensatz in EUR/h. Ohne Satz gibt es keine Schätzung.'), node('pre', '', 'JOSEV_COST_PER_HOUR_EUR=\nLLM_COST_PER_HOUR_EUR='), node('p', '', 'Den Preis der jeweils zugeordneten Rechenressource eintragen. Die Laufzeit eines Modells wird einmal gezählt, auch bei mehreren gleichzeitigen Anfragen. Dies ist eine Zeitkosten-Schätzung; ungenutzte Kapazität, Strommessung und eine Abrechnung sind darin nicht enthalten.'));
    parent.append(costs);
    const measurement = node('section', 'settings-card');
    append(measurement, node('h3', '', 'Messverhalten'), node('p', '', 'Beide Modelle werden standardmäßig gleichzeitig gemessen; auf demselben Ollama konkurrieren sie um die GPU. Für den Talk lässt sich ein vollständiger Vergleich anschließend synchron mit seinen tatsächlich gemessenen Zeitabständen abspielen.'));
    const label = node('label', 'field', null, {for: 'concurrency'});
    label.append(node('span', '', 'Gleichzeitige Anfragen pro Modell'));
    const select = node('select', '', null, {id: 'concurrency'});
    for (let value = 1; value <= (state.config?.maxConcurrency || 4); value++) select.append(node('option', '', `${value}${value === 1 ? ' · Standard' : ''}`, {value}));
    select.value = String(state.concurrency);
    select.disabled = isBusy();
    select.addEventListener('change', () => { state.concurrency = Number(select.value); });
    label.append(select);
    append(measurement, label, node('p', '', 'Der Wert gilt für beide Modelle. Höhere Parallelität verändert Durchsatz und Antwortzeiten; die Konfiguration wird im JSON-Export festgehalten.'));
    parent.append(measurement);
    parent.append(node('p', 'settings-bottom', `Decision Lab ${state.config?.version || ''} · ${state.bankingCategories.length || 77} Banking-Kategorien · synthetische deutsche Texte`));
  }
  function openSettings() { renderSettings(); $('#settingsDialog').showModal(); }

  function bindEvents() {
    const replay = node('button', 'text-button replay-button', '↻  Synchron abspielen', {id: 'replayButton', type: 'button', title: 'Einen vollständigen Vergleich mit seinen tatsächlich gemessenen Zeitabständen wiedergeben.'});
    replay.hidden = true;
    $('.stage-footer').insertBefore(replay, $('#exportButton'));
    replay.addEventListener('click', replayRun);
    $('#scenarioSelect').addEventListener('change', event => {
      const [id, preset] = event.target.value.split(':');
      if (preset) {
        state.feedPreset = preset;
      }
      selectScenario(id);
    });
    $('#runCount').addEventListener('change', () => { state.counts[state.scenario] = Number($('#runCount').value); resetView(); updateControls(); });
    $('#runMode').addEventListener('change', () => { resetView(); updateControls(); });
    $('#runSchedule').addEventListener('change', updateControls);
    $('#runButton').addEventListener('click', startRun);
    $('#stopButton').addEventListener('click', stopRun);
    $('#exportButton').addEventListener('click', exportRun);
    for (const dialog of $$('dialog')) {
      $('.dialog-close', dialog).addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
      });
    }
    window.addEventListener('beforeunload', () => { state.controller?.abort(); for (const timer of state.timers) clearTimeout(timer); });
  }

  async function init() {
    resetLanes();
    bindEvents();
    renderLanes();
    const responses = await Promise.allSettled([
      fetch('/api/scenarios', {headers: {Accept: 'application/json'}}).then(jsonResponse),
      fetch('/api/config', {headers: {Accept: 'application/json'}}).then(jsonResponse),
    ]);
    const errors = [];
    if (responses[0].status === 'fulfilled') {
      const data = responses[0].value;
      if (!Array.isArray(data.scenarios)) errors.push('Die Beispieldaten haben ein unerwartetes Format.');
      else {
        state.scenarios = data.scenarios;
        state.bankingCategories = data.bankingCategories || [];
        state.documentCategories = data.documentCategories || [];
        state.feedPresets = data.feedPresets || [];
        state.triageQuestions = data.triageQuestions || {};
      }
    } else errors.push('Beispieldaten konnten nicht geladen werden: ' + responses[0].reason.message);
    if (responses[1].status === 'fulfilled') {
      state.config = responses[1].value;
      $('#runSchedule').value = state.config.defaultSchedule || 'parallel';
      if (state.config.josev?.configured && !state.config.llm?.configured) $('#runMode').value = 'josev';
    } else errors.push('Die Serverkonfiguration konnte nicht geladen werden: ' + responses[1].reason.message);
    state.feedPreset = state.feedPresets[0]?.id;
    $('#scenarioSelect option[value="feed"]').replaceWith(...state.feedPresets.map(preset => node('option', '', 'Feed-Filter · ' + preset.label, {value: 'feed:' + preset.id})));
    selectScenario(state.scenario);
    if (errors.length) {
      showError(errors.join('\n') + '\nDie Anwendung muss über ihren Anwendungsserver geöffnet werden; eine direkt geöffnete HTML-Datei kann die Modell-API nicht erreichen.');
      setRunStatus('Serververbindung fehlt');
    }
    updateControls();
  }

  init().catch(error => {
    showError('Die Anwendung konnte nicht initialisiert werden. ' + (error.message || 'Bitte die Seite neu laden.'));
    setRunStatus('Initialisierung fehlgeschlagen');
  });
})();
