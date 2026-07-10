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

// Inserimento prodotti demo al primo avvio (DB vuoto). Disattivabile con "0".
const SEED_DEMO = process.env.POS_SEED_DEMO !== "0";

// Numero di file di backup da conservare (rotazione). 0 = illimitato.
const BACKUP_KEEP = Math.max(0, Number(process.env.BACKUP_KEEP || 20) || 0);

// Elenco operatori selezionabili all'apertura del turno (vuoto = campo libero).
const OPERATORS = String(process.env.OPERATORS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// PIN unico opzionale per proteggere l'accesso. Vuoto = nessuna protezione.
const APP_PIN = String(process.env.APP_PIN || "").trim();

const config = {
  APP_NAME,
  BUSINESS_NAME,
  APP_TAGLINE,
  CURRENCY_SYMBOL,
  LOCALE,
  SEED_DEMO,
  BACKUP_KEEP,
  OPERATORS,
  APP_PIN,
  SLUG: slugify(APP_NAME),
};

// Config esposta al frontend via GET /api/config (solo campi non sensibili).
function publicConfig() {
  return {
    appName: config.APP_NAME,
    businessName: config.BUSINESS_NAME,
    tagline: config.APP_TAGLINE,
    currencySymbol: config.CURRENCY_SYMBOL,
    locale: config.LOCALE,
    operators: config.OPERATORS,
    authRequired: Boolean(config.APP_PIN),
  };
}

module.exports = { config, publicConfig, slugify };
