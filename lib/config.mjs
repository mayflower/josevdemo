function endpoint(value, name) {
  const text = (value ?? '').trim().replace(/\/+$/, '');
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new Error(`${name} muss eine vollständige HTTP(S)-Basis-URL sein.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name}: HTTP(S) ohne eingebettete Zugangsdaten, Query oder Fragment verwenden.`);
  }
  return text;
}

function optionalRate(value, name) {
  if (value === undefined || String(value).trim() === '') return null;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0) throw new Error(`${name} muss eine nichtnegative Zahl in EUR sein.`);
  return rate;
}

function integer(value, fallback, min, max, name) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} muss zwischen ${min} und ${max} liegen.`);
  return number;
}

function optionalPrice(value, name) {
  if (value === undefined || String(value).trim() === '') return null;
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) throw new Error(`${name} muss eine nichtnegative Zahl pro 1 Mio. Token sein.`);
  return price;
}

// Both prices are needed for a token-based cost; a half-configured price is ignored.
function tokenPricing(env, prefix) {
  const input = optionalPrice(env[`${prefix}_PRICE_INPUT_PER_MTOK`], `${prefix}_PRICE_INPUT_PER_MTOK`);
  const output = optionalPrice(env[`${prefix}_PRICE_OUTPUT_PER_MTOK`], `${prefix}_PRICE_OUTPUT_PER_MTOK`);
  const note = (env[`${prefix}_PRICE_NOTE`] || '').trim();
  return input !== null && output !== null ? {inputPerMTok: input, outputPerMTok: output, ...(note ? {note} : {})} : null;
}

export function readConfig(env = process.env) {
  const currency = (env.COST_CURRENCY || 'EUR').trim().toUpperCase();
  if (!['EUR', 'USD'].includes(currency)) throw new Error('COST_CURRENCY muss EUR oder USD sein.');
  const josevUrl = endpoint(env.OLLAMA_BASE_URL, 'OLLAMA_BASE_URL');
  const provider = (env.LLM_PROVIDER || 'ollama').trim().toLowerCase();
  if (!['ollama', 'openai'].includes(provider)) throw new Error('LLM_PROVIDER muss ollama oder openai sein.');
  const llmUrl = endpoint(env.LLM_BASE_URL || (provider === 'openai' ? 'https://api.openai.com' : josevUrl), 'LLM_BASE_URL');
  const josev = {
    baseUrl: josevUrl,
    model: (env.JOSEV_MODEL || 'josev-2b').trim(),
    apiKey: env.OLLAMA_API_KEY || '',
    keepAlive: env.MODEL_KEEP_ALIVE || '10m',
    costPerHour: optionalRate(env.JOSEV_COST_PER_HOUR_EUR, 'JOSEV_COST_PER_HOUR_EUR'),
    pricing: tokenPricing(env, 'JOSEV'),
  };
  const llm = {
    provider,
    baseUrl: llmUrl,
    model: (env.LLM_MODEL || '').trim(),
    // The Ollama key must never be sent to the OpenAI API.
    apiKey: provider === 'openai' ? env.LLM_API_KEY || '' : env.LLM_API_KEY || env.OLLAMA_API_KEY || '',
    keepAlive: env.MODEL_KEEP_ALIVE || '10m',
    costPerHour: optionalRate(env.LLM_COST_PER_HOUR_EUR, 'LLM_COST_PER_HOUR_EUR'),
    pricing: tokenPricing(env, 'LLM'),
  };
  return {
    host: env.HOST || '127.0.0.1',
    port: integer(env.PORT, 3000, 0, 65535, 'PORT'),
    timeoutMs: integer(env.REQUEST_TIMEOUT_MS, 120000, 100, 600000, 'REQUEST_TIMEOUT_MS'),
    maxConcurrency: integer(env.MAX_CONCURRENCY, 4, 1, 8, 'MAX_CONCURRENCY'),
    josev, llm, currency,
    sameServer: Boolean(josevUrl && josevUrl === llmUrl),
    version: '1.0.0',
  };
}

export const isConfigured = lane => Boolean(lane.baseUrl && lane.model && (lane.provider !== 'openai' || lane.apiKey));

export function publicConfig(config) {
  const safe = lane => ({model: lane.model, provider: lane.provider, configured: isConfigured(lane), costPerHour: lane.costPerHour, pricing: lane.pricing});
  return {
    josev: safe(config.josev), llm: safe(config.llm), currency: config.currency, sameServer: config.sameServer,
    defaultSchedule: 'parallel', maxConcurrency: config.maxConcurrency, version: config.version,
    costBasis: 'Kosten aus tatsächlich gemeldeten Token × konfigurierter Preis pro 1 Mio. Token, sonst gemessene Laufzeit × Ressourcensatz pro Stunde. Warm-up separat; keine Rechnung und keine Strommessung.',
    notes: [
      'Josev: /v1/systemone. Vergleichs-LLM: Ollama /api/chat oder OpenAI /v1/chat/completions, jeweils mit festem JSON-Schema.',
      'Beide Modelle erhalten dieselben Texte, Ausgangsoptionen und dieselbe Entscheidungsstrategie. Banking-Finalisten entstehen je Modell. Sollwerte werden nicht an Modelle übertragen.',
      'Beide Modelle starten gleichzeitig. Auf demselben Ollama konkurrieren sie um GPU und Speicher; die Zeiten sind dadurch nicht isoliert.',
      'Banking: 77 Intents in zwei Stufen (26/26/25 Kandidaten, danach drei Finalisten); derselbe Ablauf für beide Modelle.',
    ],
  };
}
