import {scenarios, triageQuestions, feedPresets, bankingCategories, documentCategories} from '../data/fixtures.mjs';

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'InputError'; this.status = status; }
}

export const extractionFields = {
  invoice_number: {label: 'Rechnungsnummer', instructions: 'Welche Rechnungsnummer gehört zur aktuellen Rechnung? Ignoriere ältere oder nur zum Vergleich genannte Rechnungen.', pattern: /\b(?:RE|RG|INV|R)[-/]\d{4}[-/]\d{2,8}\b/gi},
  total_due: {label: 'Zahlbetrag', instructions: 'Welcher ausdrücklich genannte Gesamt- oder Restbetrag ist für die aktuelle Rechnung jetzt offen, vor optionalem noch nicht genutztem Skonto? Ignoriere Netto-Zwischensummen, bereits bezahlte Beträge und frühere Rechnungen. Ein ausdrücklich offener Betrag von 0,00 € ist ein gültiger Wert.', pattern: /\b(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}[ \u00a0]*(?:€|EUR)/gi},
  due_date: {label: 'Fällig am', instructions: 'Welches ausdrücklich genannte Datum ist das reguläre Zahlungsziel der aktuellen Rechnung? Ignoriere eine frühere optionale Skontofrist, Rechnungsdatum, Lieferdatum und bereits erfolgte Zahlungen.', pattern: /\b\d{2}\.\d{2}\.\d{4}\b/g},
  po_number: {label: 'Bestellnummer', instructions: 'Welche Bestellnummer (PO) gehört ausdrücklich zur aktuellen Rechnung? Ignoriere frühere oder fremde Bestellungen.', pattern: /\bPO[-/]\d{4}[-/]\d{2,8}\b/gi},
  billing_email: {label: 'Rechnungsadresse', instructions: 'Welche E-Mail-Adresse ist ausdrücklich für Rechnungen, Buchhaltung oder die Bearbeitung der aktuellen Rechnung bestimmt? Ignoriere Vertrieb, Versand und technischen Support.', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi},
};

export function extractCandidates(text) {
  return Object.fromEntries(Object.entries(extractionFields).map(([key, field]) => [key, [...new Set(text.match(field.pattern) || [])]]));
}

export function selectRun(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Ungültige Laufkonfiguration.');
  const scenario = scenarios.find(entry => entry.id === body.scenario);
  if (!scenario) throw new InputError('Unbekannter Demo-Fall.');
  const mode = body.mode || 'josev';
  if (!['josev', 'compare'].includes(mode)) throw new InputError('Unbekannter Vergleichsmodus.');
  const schedule = body.schedule || 'sequential';
  if (!['sequential', 'parallel'].includes(schedule)) throw new InputError('Unbekannte Ausführungsreihenfolge.');
  const concurrency = body.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > config.maxConcurrency) throw new InputError(`Parallelität muss zwischen 1 und ${config.maxConcurrency} liegen.`);
  const count = body.count ?? Math.min(12, scenario.items.length);
  if (!Number.isInteger(count) || count < 1 || count > scenario.items.length) throw new InputError(`Für diesen Fall sind 1 bis ${scenario.items.length} Beispiele verfügbar.`);
  if (body.warmup !== undefined && typeof body.warmup !== 'boolean') throw new InputError('Warm-up muss ein Wahrheitswert sein.');
  const preset = feedPresets.find(entry => entry.id === (body.feedPreset || feedPresets[0].id));
  if (!preset) throw new InputError('Unbekannter Feed-Filter.');
  if (body.feedCondition !== undefined && typeof body.feedCondition !== 'string') throw new InputError('Die Filterbedingung muss Text sein.');
  const feedCondition = (body.feedCondition || '').trim();
  if (feedCondition.length > 1200) throw new InputError('Die Filterbedingung darf höchstens 1.200 Zeichen enthalten.');
  const options = {mode, schedule, concurrency, warmup: body.warmup !== false, feedPreset: preset.id, feedCondition: feedCondition || preset.instructions, customFeed: Boolean(feedCondition && feedCondition !== preset.instructions)};
  let items = scenario.items.slice(0, count);
  if (body.customText !== undefined && typeof body.customText !== 'string') throw new InputError('Eigener Text muss eine Zeichenfolge sein.');
  if (body.customText?.trim()) {
    if (body.customText.length > 12000) throw new InputError('Eigener Text darf höchstens 12.000 Zeichen enthalten.');
    items = [{id: `${scenario.id}-custom`, title: 'Eigenes Beispiel', text: body.customText.trim(), expected: null, batchId: 'custom', pageNumber: 1, previousText: ''}];
  }
  return {scenario, items, options};
}

const noul = instructions => ({type: 'noul', instructions, criteria: {false: 'Nein, trifft nicht zu.', true: 'Ja, trifft zu.'}});
const criteriaFrom = rows => Object.fromEntries(rows.map(row => [row.id, row.description || row.label]));

export function prepareTask(scenarioId, item, options = {}) {
  if (scenarioId === 'triage') return {state: item.text, questions: triageQuestions, expected: item.expected};
  if (scenarioId === 'feed') return {
    state: item.text,
    questions: {match: noul(options.feedCondition || feedPresets[0].instructions)},
    expected: item.expectedByPreset && !options.customFeed ? {match: item.expectedByPreset[options.feedPreset || feedPresets[0].id]} : null,
  };
  if (scenarioId === 'documents') return {
    state: {vorherige_seite: item.previousText || '(Keine vorherige Seite: Anfang des Stapels.)', aktuelle_seite: item.text},
    questions: {
      category: {type: 'choice', instructions: 'Zu welcher Dokumentart gehört die aktuelle Seite? Verwende die vorherige Seite nur als Kontext.', criteria: criteriaFrom(documentCategories)},
      new_document: noul('Beginnt mit der aktuellen Seite ein neues eigenständiges Dokument? Erste Seite eines Stapels: ja. Eine Fortsetzungsseite desselben Dokuments: nein. Auch direkt aufeinanderfolgende Dokumente derselben Art sind eigenständige Dokumente, wenn sie verschiedene Rechnungen, Verträge oder Schreiben sind.'),
    },
    expected: item.expected,
  };
  if (scenarioId === 'banking') return {state: item.text, expected: item.expected, banking: true};
  if (scenarioId === 'extract') {
    const candidates = extractCandidates(item.text);
    const questions = {}, decode = {}, constants = {};
    for (const [key, values] of Object.entries(candidates)) {
      if (values.length > 25) throw new InputError(`Zu viele Kandidaten für ${extractionFields[key].label}: maximal 25 pro Feld.`);
      if (!values.length) { constants[key] = 'none'; continue; }
      decode[key] = Object.fromEntries(values.map((value, index) => [`v${index + 1}`, value]));
      decode[key].none = 'none';
      questions[key] = {
        type: 'choice',
        instructions: `${extractionFields[key].instructions} Wähle einen Originalwert. Wenn kein Kandidat die gesuchte Rolle hat oder die Angabe fehlt, wähle none. Nichts berechnen und nichts ergänzen.`,
        criteria: {...decode[key], none: 'Die gesuchte Angabe fehlt; keiner der Kandidaten passt.'},
      };
    }
    if (!Object.keys(questions).length) throw new InputError('Keine Rechnungswerte im Text gefunden. Bitte ein Rechnungsbeispiel mit Nummer, Datum, Eurobetrag oder E-Mail verwenden.');
    return {state: item.text, questions, decode, constants, candidates, expected: item.expected};
  }
  throw new InputError('Unbekannte Aufgabe.');
}

export function bankingRoundOne() {
  const options = bankingCategories.map((category, index) => ({...category, key: `i${String(index + 1).padStart(2, '0')}`}));
  const groups = [options.slice(0, 26), options.slice(26, 52), options.slice(52)];
  const questions = Object.fromEntries(groups.map((group, index) => [`group_${index + 1}`, {
    type: 'choice', instructions: 'Welches der hier angebotenen Bankanliegen passt am besten zur Nachricht? Wähle den passendsten Kandidaten aus dieser Teilmenge; weitere Teilmengen werden separat geprüft.',
    criteria: Object.fromEntries(group.map(category => [category.key, category.description])),
  }]));
  return {questions, options};
}

function addKnown(responses, path) {
  const values = responses.map(response => path.reduce((value, key) => value?.[key], response));
  return values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) : null;
}

export async function executeTask(task, invoke, signal) {
  const responses = [];
  let answers, stages = 1, trace = [];
  if (task.banking) {
    const first = bankingRoundOne();
    const response = await invoke({state: task.state, questions: first.questions, signal});
    responses.push(response);
    const finalists = Object.values(response.answers).map(answer => first.options.find(option => option.key === answer.value));
    if (finalists.length !== 3 || finalists.some(entry => !entry)) throw new Error('Ungültige Banking-Kandidaten.');
    const finalResponse = await invoke({state: task.state, questions: {intent: {
      type: 'choice', instructions: 'Welches dieser drei Bankanliegen beschreibt die Nachricht am besten? Wähle genau ein Anliegen.',
      criteria: Object.fromEntries(finalists.map(category => [category.key, category.description])),
    }}, signal});
    responses.push(finalResponse);
    const selected = finalists.find(category => category.key === finalResponse.answers.intent.value);
    if (!selected) throw new Error('Ungültiges Banking-Ergebnis.');
    answers = {intent: {...finalResponse.answers.intent, value: selected.id}};
    // The final probability is conditional on these three candidates, not all 77.
    trace = [{stage: 'candidates', candidates: finalists.map(category => category.id)}, {stage: 'final', intent: selected.id}];
    stages = 2;
  } else {
    const response = await invoke({state: task.state, questions: task.questions, signal});
    responses.push(response);
    answers = response.answers;
  }
  const values = {...task.constants};
  const probabilities = {};
  for (const [key, answer] of Object.entries(answers)) {
    values[key] = task.decode?.[key] ? task.decode[key][answer.value] : answer.value;
    if (Number.isFinite(answer.probability)) probabilities[key] = answer.probability;
  }
  const expectedEntries = task.expected && Object.entries(task.expected).filter(([, value]) => value !== undefined);
  const correct = expectedEntries?.length ? {matched: expectedEntries.filter(([key, expected]) => values[key] === expected).length, total: expectedEntries.length} : null;
  return {
    values, probabilities, correct, stages, trace,
    probabilityScope: task.banking ? 'P(Auswahl | drei Finalisten)' : 'noul: P(Ja); choice: P(gewählte Option)',
    deterministicFields: Object.keys(task.constants || {}),
    decisions: task.banking ? 4 : Object.keys(task.questions).length,
    candidates: task.candidates,
    usage: {inputTokens: addKnown(responses, ['usage', 'inputTokens']), outputTokens: addKnown(responses, ['usage', 'outputTokens'])},
    providerTiming: {wallMs: addKnown(responses, ['timing', 'wallMs']), loadMs: addKnown(responses, ['timing', 'loadMs']), computeMs: addKnown(responses, ['timing', 'computeMs'])},
  };
}

export const warmupTask = {
  state: 'Dies ist eine kurze technische Aufwärmanfrage. Die Ampel ist grün.',
  questions: {ready: noul('Wird eine grüne Ampel erwähnt?')},
};
