// Configurazione centrale dell'applicazione.
// Tutti i valori sono sovrascrivibili via variabili d'ambiente (.env),
// così lo stesso software puo' essere usato per qualsiasi attivita'/evento.

const net = require("node:net");

function slugify(value) {
  return String(value || "pos")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // rimuove accenti
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "pos";
}

// Nome mostrato nell'interfaccia (header, titoli pagina).
const APP_NAME = process.env.APP_NAME || "EventOrder";

// Nome dell'attivita' stampato sul ticket. Default: uguale ad APP_NAME.
const BUSINESS_NAME = process.env.BUSINESS_NAME || APP_NAME;

// Sottotitolo generico mostrato nell'header (opzionale).
const APP_TAGLINE = process.env.APP_TAGLINE || "Cassa locale";

// Valuta e localizzazione.
const CURRENCY_SYMBOL = process.env.CURRENCY_SYMBOL || "€";
const LOCALE = process.env.LOCALE || "it-IT";
const CURRENCY_CODE = String(process.env.CURRENCY_CODE || "EUR").trim().toUpperCase();
try {
  new Intl.NumberFormat(LOCALE, { style: "currency", currency: CURRENCY_CODE }).format(0);
} catch {
  throw new Error("LOCALE o CURRENCY_CODE non validi");
}

// Inserimento prodotti demo al primo avvio (DB vuoto). Disattivabile con "0".
const SEED_DEMO = process.env.POS_SEED_DEMO !== "0";

// Numero di file di backup da conservare (rotazione). 0 = illimitato.
function integerEnv(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} deve essere un numero intero`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} deve essere compreso tra ${min} e ${max}`);
  }
  return value;
}

const BACKUP_KEEP = integerEnv("BACKUP_KEEP", 20, { min: 0, max: 10000 });
const PRE_MIGRATION_BACKUP_KEEP = integerEnv(
  "PRE_MIGRATION_BACKUP_KEEP", 3, { min: 0, max: 10000 }
);
const AUDIT_RETENTION_DAYS = integerEnv("AUDIT_RETENTION_DAYS", 90, { min: 0, max: 36500 });
const OPERATION_REQUEST_RETENTION_DAYS = integerEnv(
  "OPERATION_REQUEST_RETENTION_DAYS", 30, { min: 0, max: 36500 }
);
const PORT = integerEnv("PORT", 3000, { min: 0, max: 65535 });
const LOG_REQUESTS = process.env.LOG_REQUESTS === "1";

// Elenco operatori selezionabili all'apertura del turno (vuoto = campo libero).
const OPERATORS = String(process.env.OPERATORS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// PIN unico opzionale per proteggere l'accesso. Vuoto = nessuna protezione.
const APP_PIN = String(process.env.APP_PIN || "").trim();
if (APP_PIN && !/^\d{1,8}$/.test(APP_PIN)) {
  throw new Error("APP_PIN deve contenere da 1 a 8 cifre");
}

// Per sicurezza l'app ascolta solo sulla macchina locale. Per l'uso da tablet
// sulla LAN va impostato esplicitamente HOST=0.0.0.0 con le guardie qui sotto.
const HOST = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const isLoopback = LOOPBACK_HOSTS.has(HOST.toLowerCase());
if (!isLoopback && !APP_PIN) {
  throw new Error("APP_PIN e' obbligatorio quando HOST espone l'app fuori dal loopback");
}
if (!isLoopback && APP_PIN.length < 4) {
  throw new Error("APP_PIN deve contenere almeno 4 cifre quando l'app e' esposta in LAN");
}

function normalizeAllowedHost(value) {
  let host = String(value || "").trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (net.isIP(host)) return host;
  if (host.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  if (host.split(".").some(label => !label
      || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    return null;
  }
  return host;
}

const rawAllowedHosts = String(process.env.ALLOWED_HOSTS || "").trim();
const ALLOWED_HOSTS = rawAllowedHosts
  ? [...new Set(rawAllowedHosts.split(",").map(value => {
    const normalized = normalizeAllowedHost(value);
    if (!normalized) throw new Error(`ALLOWED_HOSTS contiene un host non valido: ${value.trim()}`);
    return normalized;
  }))]
  : (isLoopback ? ["127.0.0.1", "::1", "localhost"] : []);
if (!isLoopback && ALLOWED_HOSTS.length === 0) {
  throw new Error("ALLOWED_HOSTS e' obbligatorio quando HOST espone l'app fuori dal loopback");
}

function normalizePublicOrigin(value) {
  if (!value) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN deve essere un origin HTTP/HTTPS senza percorso");
  }
  if (!["http:", "https:"].includes(parsed.protocol)
      || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("PUBLIC_ORIGIN deve essere un origin HTTP/HTTPS senza percorso");
  }
  return parsed.origin;
}

const PUBLIC_ORIGIN = normalizePublicOrigin(String(process.env.PUBLIC_ORIGIN || "").trim());
if (!isLoopback && !PUBLIC_ORIGIN) {
  throw new Error("PUBLIC_ORIGIN e' obbligatorio quando HOST espone l'app fuori dal loopback");
}
if (PUBLIC_ORIGIN) {
  const publicHost = normalizeAllowedHost(new URL(PUBLIC_ORIGIN).hostname);
  if (!ALLOWED_HOSTS.includes(publicHost)) {
    throw new Error("L'host di PUBLIC_ORIGIN deve essere incluso in ALLOWED_HOSTS");
  }
}

const rawTrustProxy = String(process.env.TRUST_PROXY || "").trim().toLowerCase();
if (rawTrustProxy && rawTrustProxy !== "loopback") {
  throw new Error("TRUST_PROXY ammette solo il valore 'loopback'");
}
const TRUST_PROXY = rawTrustProxy || false;
if (PUBLIC_ORIGIN.startsWith("https://") && TRUST_PROXY !== "loopback") {
  throw new Error("TRUST_PROXY=loopback e' obbligatorio quando PUBLIC_ORIGIN usa HTTPS");
}

const workerCount = Number(process.env.WEB_CONCURRENCY || 1);
if (workerCount > 1 || process.env.NODE_UNIQUE_ID) {
  throw new Error("EventOrder supporta un solo processo per database SQLite");
}

const config = {
  APP_NAME,
  BUSINESS_NAME,
  APP_TAGLINE,
  CURRENCY_SYMBOL,
  CURRENCY_CODE,
  LOCALE,
  SEED_DEMO,
  BACKUP_KEEP,
  PRE_MIGRATION_BACKUP_KEEP,
  AUDIT_RETENTION_DAYS,
  OPERATION_REQUEST_RETENTION_DAYS,
  OPERATORS,
  APP_PIN,
  HOST,
  ALLOWED_HOSTS,
  PUBLIC_ORIGIN,
  TRUST_PROXY,
  PORT,
  LOG_REQUESTS,
  SLUG: slugify(APP_NAME),
};

// Config esposta al frontend via GET /api/config (solo campi non sensibili).
function publicConfig({ includeOperators = true } = {}) {
  return {
    appName: config.APP_NAME,
    businessName: config.BUSINESS_NAME,
    tagline: config.APP_TAGLINE,
    currencySymbol: config.CURRENCY_SYMBOL,
    currencyCode: config.CURRENCY_CODE,
    locale: config.LOCALE,
    operators: includeOperators ? config.OPERATORS : [],
    authRequired: Boolean(config.APP_PIN),
  };
}

module.exports = { config, publicConfig, slugify };
