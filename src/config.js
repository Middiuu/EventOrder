// Configurazione centrale dell'applicazione.
// Tutti i valori sono sovrascrivibili via variabili d'ambiente (.env),
// così lo stesso software puo' essere usato per qualsiasi attivita'/evento.

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
// sulla LAN va impostato esplicitamente HOST=0.0.0.0 (e configurato APP_PIN).
const HOST = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(HOST.toLowerCase()) && !APP_PIN) {
  throw new Error("APP_PIN e' obbligatorio quando HOST espone l'app fuori dal loopback");
}
if (!LOOPBACK_HOSTS.has(HOST.toLowerCase()) && APP_PIN.length < 4) {
  throw new Error("APP_PIN deve contenere almeno 4 cifre quando l'app e' esposta in LAN");
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
  OPERATORS,
  APP_PIN,
  HOST,
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
