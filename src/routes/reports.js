const express = require("express");
const {
  db,
  DB_PATH,
  getOpenSession,
  validateRestoreCandidate,
  restoreDatabaseFromFile,
} = require("../db");
const { config } = require("../config");
const { localYmdToUtcSql, parseLocalYmd } = require("../validation");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  beginBackup,
  endBackup,
  beginRestore,
  endRestore,
} = require("../maintenance");

const router = express.Router();

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatLocalDateYYYYMMDD(d = new Date()) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

function addDays(dateObj, days) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + days);
  return d;
}

function rangeError(message) {
  const err = new Error(message);
  err.status = 400;
  err.publicMessage = message;
  return err;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",;\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function centsToEuroString(cents) {
  return (Number(cents) / 100).toFixed(2).replace(".", ",");
}

/**
 * Ritorna range [from,to) in local time.
 * Query:
 *  - from=YYYY-MM-DD (default: oggi)
 *  - to=YYYY-MM-DD   (default: domani)  <-- to è esclusivo
 */
function getRangeFromQuery(req) {
  const today = formatLocalDateYYYYMMDD(new Date());
  const fromDay = String(req.query.from || today).trim();
  const fromDate = parseLocalYmd(fromDay);
  if (!fromDate) throw rangeError("Data 'from' non valida: usa YYYY-MM-DD");

  // default: from + 1 giorno
  const autoTo = formatLocalDateYYYYMMDD(addDays(fromDate, 1));
  const toDay = String(req.query.to || autoTo).trim();
  const toDate = parseLocalYmd(toDay);
  if (!toDate) throw rangeError("Data 'to' non valida: usa YYYY-MM-DD");
  if (toDate <= fromDate) throw rangeError("La data 'to' deve essere successiva a 'from'");

  // created_at e' memorizzato come UTC. Convertiamo i confini locali una
  // sola volta, lasciando la colonna nuda nella query cosi' l'indice resta usabile.
  const from = localYmdToUtcSql(fromDay);
  const to = localYmdToUtcSql(toDay);

  return { fromDay, toDay, from, to };
}

// --- Selezione vendite per i report: intervallo di date locali (from/to,
// to esclusivo) oppure un turno specifico (?session=id).
function salesScopeFromQuery(req) {
  if (req.query.session !== undefined) {
    const sessionId = Number(req.query.session);
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      throw rangeError("Turno non valido");
    }
    return { where: "s.session_id = ?", params: [sessionId], sessionId };
  }
  const { fromDay, toDay, from, to } = getRangeFromQuery(req);
  return {
    where: "s.created_at >= ? AND s.created_at < ?",
    params: [from, to],
    fromDay,
    toDay,
  };
}

// Vendite del perimetro con le rispettive righe (per la ripartizione sconti).
// created_at e' salvato in UTC: convertito in ora locale gia' in query, cosi'
// le vendite dopo mezzanotte restano attribuite alla serata giusta.
function loadScopedSales(scope, { includeVoided = false } = {}) {
  const voidedFilter = includeVoided ? "" : "AND s.voided = 0";
  const sales = db.prepare(`
    SELECT s.id, s.sale_number, s.total_cents, s.discount_cents, s.payment_method,
           s.operator, s.session_id, s.note, s.voided,
           datetime(s.created_at, 'localtime') AS created_local
    FROM sales s
    WHERE ${scope.where} ${voidedFilter}
    ORDER BY s.id ASC
  `).all(...scope.params);

  const itemsBySale = new Map();
  const ids = sales.map(s => s.id);
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const items = db.prepare(`
      SELECT id, sale_id, qty, unit_price_cents, line_total_cents,
             product_name, product_category, product_cost_cents,
             options_json, note
      FROM sale_items
      WHERE sale_id IN (${placeholders})
      ORDER BY id ASC
    `).all(...ids);
    for (const it of items) {
      if (!itemsBySale.has(it.sale_id)) itemsBySale.set(it.sale_id, []);
      itemsBySale.get(it.sale_id).push(it);
    }
  }
  return { sales, itemsBySale };
}

// Ripartisce lo sconto della vendita sulle righe in proporzione al lordo
// (metodo dei resti maggiori): la somma dei netti coincide esattamente
// con il totale incassato della vendita.
function allocateNetByItem(sale, items) {
  const net = new Map();
  const subtotal = items.reduce((sum, it) => sum + it.line_total_cents, 0);
  if (!sale.discount_cents || subtotal <= 0) {
    for (const it of items) net.set(it.id, it.line_total_cents);
    return net;
  }
  const target = sale.total_cents;
  const shares = items.map(it => {
    const raw = it.line_total_cents * target / subtotal;
    return { id: it.id, floor: Math.floor(raw), frac: raw - Math.floor(raw) };
  });
  let remainder = target - shares.reduce((sum, sh) => sum + sh.floor, 0);
  shares.sort((a, b) => b.frac - a.frac);
  for (const sh of shares) {
    net.set(sh.id, sh.floor + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder -= 1;
  }
  return net;
}

// Aggregato per prodotto: quantita', lordo, netto sconti e margine
// (solo dove il costo era tracciato al momento della vendita).
function productBreakdown(sales, itemsBySale) {
  const agg = new Map();
  for (const sale of sales) {
    const items = itemsBySale.get(sale.id) || [];
    const net = allocateNetByItem(sale, items);
    for (const it of items) {
      const row = agg.get(it.product_name) || {
        name: it.product_name,
        category: it.product_category,
        qty_sold: 0,
        gross_revenue_cents: 0,
        net_revenue_cents: 0,
        tracked_net_revenue_cents: 0,
        cost_cents: 0,
        tracked_items: 0,
        untracked_items: 0,
      };
      row.qty_sold += it.qty;
      row.gross_revenue_cents += it.line_total_cents;
      row.net_revenue_cents += net.get(it.id) || 0;
      if (it.product_cost_cents == null) {
        row.untracked_items += 1;
      } else {
        row.tracked_items += 1;
        row.tracked_net_revenue_cents += net.get(it.id) || 0;
        row.cost_cents += it.product_cost_cents * it.qty;
      }
      agg.set(it.product_name, row);
    }
  }
  return [...agg.values()]
    .map(row => ({
      ...row,
      revenue_cents: row.gross_revenue_cents, // nome storico: lordo
      cost_tracked: row.untracked_items === 0,
      margin_complete: row.untracked_items === 0,
      // Se il costo copre solo alcune vendite, mostriamo il margine noto
      // marcandolo esplicitamente come parziale invece di scartarlo tutto.
      margin_cents: row.tracked_items > 0
        ? row.tracked_net_revenue_cents - row.cost_cents
        : null,
    }))
    .sort((a, b) => b.qty_sold - a.qty_sold || b.net_revenue_cents - a.net_revenue_cents);
}

function buildSummary(scope) {
  const { sales, itemsBySale } = loadScopedSales(scope);

  const byProduct = productBreakdown(sales, itemsBySale);
  const trackedProducts = byProduct.filter(p => p.margin_cents !== null);
  const trackedRevenueCents = byProduct.reduce((sum, p) => sum + p.tracked_net_revenue_cents, 0);
  const totalRevenueCents = sales.reduce((sum, s) => sum + s.total_cents, 0);
  const marginComplete = byProduct.length > 0 && byProduct.every(p => p.margin_complete);

  const summary = {
    sales_count: sales.length,
    revenue_cents: totalRevenueCents,
    discount_cents: sales.reduce((sum, s) => sum + s.discount_cents, 0),
    margin_cents: trackedProducts.length
      ? trackedProducts.reduce((sum, p) => sum + p.margin_cents, 0)
      : null,
    margin_products: trackedProducts.length,
    margin_total_products: byProduct.length,
    margin_complete: marginComplete,
    margin_tracked_revenue_cents: trackedRevenueCents,
    margin_coverage_percent: totalRevenueCents > 0
      ? Math.round(trackedRevenueCents / totalRevenueCents * 100)
      : (marginComplete ? 100 : 0),
  };

  const payAgg = new Map();
  const hourAgg = new Map();
  const dayAgg = new Map();
  for (const s of sales) {
    const pay = payAgg.get(s.payment_method) || { payment_method: s.payment_method, count: 0, revenue_cents: 0 };
    pay.count += 1;
    pay.revenue_cents += s.total_cents;
    payAgg.set(s.payment_method, pay);

    const hour = Number(s.created_local.slice(11, 13));
    hourAgg.set(hour, (hourAgg.get(hour) || 0) + s.total_cents);

    const day = s.created_local.slice(0, 10);
    const d = dayAgg.get(day) || { day, sales_count: 0, revenue_cents: 0 };
    d.sales_count += 1;
    d.revenue_cents += s.total_cents;
    dayAgg.set(day, d);
  }

  const byPayment = [...payAgg.values()].sort((a, b) => b.revenue_cents - a.revenue_cents);
  const byHour = [...hourAgg.entries()]
    .map(([hour, revenue_cents]) => ({ hour, revenue_cents }))
    .sort((a, b) => a.hour - b.hour);
  const byDay = [...dayAgg.values()].sort((a, b) => a.day.localeCompare(b.day));

  return { summary, byProduct, byPayment, byHour, byDay };
}

// --- JSON report su intervallo di date o turno (default: oggi)
router.get("/summary", (req, res) => {
  const scope = salesScopeFromQuery(req);
  res.json({
    ...buildSummary(scope),
    fromDay: scope.fromDay ?? null,
    toDay: scope.toDay ?? null,
    session: scope.sessionId ?? null,
  });
});

// --- Alias storico: report di oggi
router.get("/today", (req, res) => {
  res.json(buildSummary(salesScopeFromQuery({ query: {} })));
});

// Etichetta del perimetro per i nomi file (intervallo o turno)
function scopeLabel(scope) {
  return scope.sessionId ? `turno-${scope.sessionId}` : `${scope.fromDay}_to_${scope.toDay}`;
}

function sendCsv(res, filename, lines) {
  // BOM per Excel (UTF-8)
  const bom = "\uFEFF";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(bom + lines.join("\n"));
}

// --- CSV export aggregato per prodotto (Excel-friendly, separatore ';')
router.get("/export.csv", (req, res) => {
  const scope = salesScopeFromQuery(req);
  const { summary, byProduct } = buildSummary(scope);

  const sep = ";";
  const header = [
    "from",
    "to_exclusive",
    "sales_count",
    "total_revenue_eur",
    "product_name",
    "qty_sold",
    "product_gross_revenue_eur",
    "product_net_revenue_eur",
    "product_margin_eur",
    "product_margin_complete"
  ].join(sep);

  const lines = [header];
  const fromLabel = scope.fromDay || `turno-${scope.sessionId}`;
  const toLabel = scope.toDay || "";

  if (byProduct.length === 0) {
    // comunque esporta una riga "vuota" con i totali
    lines.push([
      fromLabel,
      toLabel,
      String(summary.sales_count),
      centsToEuroString(summary.revenue_cents),
      "",
      "0",
      "0,00",
      "0,00",
      "",
      ""
    ].map(csvEscape).join(sep));
  } else {
    for (const r of byProduct) {
      lines.push([
        fromLabel,
        toLabel,
        String(summary.sales_count),
        centsToEuroString(summary.revenue_cents),
        r.name,
        String(r.qty_sold),
        centsToEuroString(r.gross_revenue_cents),
        centsToEuroString(r.net_revenue_cents),
        r.margin_cents === null ? "" : centsToEuroString(r.margin_cents),
        r.margin_cents === null ? "" : (r.margin_complete ? "1" : "0")
      ].map(csvEscape).join(sep));
    }
  }

  sendCsv(res, `${config.SLUG}_${scopeLabel(scope)}.csv`, lines);
});

// --- CSV export riga-per-articolo (con sconto ripartito e costo storicizzato)
router.get("/items.csv", (req, res) => {
  const scope = salesScopeFromQuery(req);
  const { sales, itemsBySale } = loadScopedSales(scope, { includeVoided: true });

  const sep = ";";
  const header = [
    "sale_number",
    "datetime",
    "operator",
    "session_id",
    "payment_method",
    "voided",
    "product_name",
    "category",
    "options",
    "item_note",
    "order_note",
    "qty",
    "unit_price_eur",
    "line_gross_eur",
    "line_discount_eur",
    "line_net_eur",
    "line_cost_eur",
  ].join(sep);

  const lines = [header];
  for (const sale of sales) {
    const items = itemsBySale.get(sale.id) || [];
    const net = allocateNetByItem(sale, items);
    for (const it of items) {
      const netCents = net.get(it.id) || 0;
      lines.push([
        String(sale.sale_number),
        sale.created_local || "",
        sale.operator || "",
        sale.session_id == null ? "" : String(sale.session_id),
        sale.payment_method || "",
        sale.voided ? "1" : "0",
        it.product_name,
        it.product_category,
        (() => {
          try { return JSON.parse(it.options_json || "[]").map(option => `${option.group_name}: ${option.name}`).join(" | "); }
          catch { return ""; }
        })(),
        it.note || "",
        sale.note || "",
        String(it.qty),
        centsToEuroString(it.unit_price_cents),
        centsToEuroString(it.line_total_cents),
        centsToEuroString(it.line_total_cents - netCents),
        centsToEuroString(netCents),
        it.product_cost_cents == null ? "" : centsToEuroString(it.product_cost_cents * it.qty),
      ].map(csvEscape).join(sep));
    }
  }

  sendCsv(res, `${config.SLUG}_righe_${scopeLabel(scope)}.csv`, lines);
});

// --- CSV export per-transazione (una riga per vendita, per contabilita')
router.get("/transactions.csv", (req, res) => {
  const scope = salesScopeFromQuery(req);

  const rows = db.prepare(`
    SELECT
      s.sale_number,
      datetime(s.created_at, 'localtime') AS created_local,
      s.operator,
      s.payment_method,
      s.discount_cents,
      s.total_cents,
      s.voided,
      s.session_id,
      s.note
    FROM sales s
    WHERE ${scope.where}
    ORDER BY s.sale_number ASC
  `).all(...scope.params);

  const sep = ";";
  const header = [
    "sale_number",
    "datetime",
    "operator",
    "payment_method",
    "discount_eur",
    "total_eur",
    "voided",
    "session_id",
    "order_note",
  ].join(sep);

  const lines = [header];
  for (const r of rows) {
    lines.push([
      String(r.sale_number),
      r.created_local || "",
      r.operator || "",
      r.payment_method || "",
      centsToEuroString(r.discount_cents),
      centsToEuroString(r.total_cents),
      r.voided ? "1" : "0",
      r.session_id == null ? "" : String(r.session_id),
      r.note || "",
    ].map(csvEscape).join(sep));
  }

  sendCsv(res, `${config.SLUG}_transazioni_${scopeLabel(scope)}.csv`, lines);
});

function backupStamp(now = new Date()) {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-` +
    `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

function getBackupsDir() {
  const backupsDir = path.join(path.dirname(DB_PATH), "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  return backupsDir;
}

async function createDatabaseBackup(kind = "backup") {
  if (!fs.existsSync(DB_PATH)) {
    const err = new Error("Database non trovato");
    err.status = 404;
    err.publicMessage = err.message;
    throw err;
  }

  const backupsDir = getBackupsDir();
  const base = `${config.SLUG}-${kind}-${backupStamp()}`;
  let backupName = `${base}.sqlite`;
  let suffix = 2;
  while (fs.existsSync(path.join(backupsDir, backupName))) {
    backupName = `${base}-${suffix++}.sqlite`;
  }
  const backupPath = path.join(backupsDir, backupName);

  // Backup online consistente: e' valido anche mentre altre richieste leggono.
  await db.backup(backupPath);
  pruneBackups(backupsDir);
  return { backupName, backupPath, backupsDir };
}

// --- Backup DB (copia consistente e download)
router.get("/backup", async (req, res, next) => {
  if (!beginBackup()) {
    res.setHeader("Retry-After", "2");
    return res.status(503).json({
      error: "Backup o ripristino del database in corso. Riprova tra pochi secondi.",
    });
  }
  try {
    const { backupName, backupPath } = await createDatabaseBackup();

    // Inviamo il file come buffer: il database e' piccolo e il download resta
    // affidabile anche se la rotazione dei backup parte subito dopo.
    const data = fs.readFileSync(backupPath);
    res.setHeader("Content-Type", "application/x-sqlite3");
    res.setHeader("Content-Disposition", `attachment; filename="${backupName}"`);
    res.send(data);
  } catch (err) {
    next(err);
  } finally {
    endBackup();
  }
});

const restoreBody = express.raw({
  type: ["application/octet-stream", "application/x-sqlite3", "application/vnd.sqlite3"],
  limit: "100mb",
});

function requireRestoreConfirmation(req, res, next) {
  if (req.get("X-EventOrder-Restore") !== "RESTORE") {
    return res.status(400).json({ error: "Conferma di ripristino mancante" });
  }
  next();
}

function acquireRestoreLock(req, res, next) {
  if (!beginRestore()) {
    return res.status(409).json({
      error: "Attendi la conclusione del backup o ripristino gia' in corso",
    });
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    endRestore();
  };
  res.once("finish", release);
  res.once("close", release);
  next();
}

// Il lock precede il parser del file: anche durante un upload lento nessuna
// nuova cassa o vendita puo' entrare nella finestra di ripristino.
router.post("/restore", requireRestoreConfirmation, acquireRestoreLock, restoreBody, async (req, res, next) => {
  let candidatePath;
  try {
    if (getOpenSession()) {
      return res.status(409).json({ error: "Chiudi la cassa prima di ripristinare un backup" });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "Seleziona un file di backup SQLite" });
    }

    // Il candidato resta accanto al DB: la sostituzione finale puo' quindi
    // usare rename atomico senza attraversare filesystem differenti.
    candidatePath = `${DB_PATH}.restore-upload-${process.pid}-${crypto.randomUUID()}`;
    fs.writeFileSync(candidatePath, req.body, { flag: "wx", mode: 0o600 });
    const inspected = validateRestoreCandidate(candidatePath);

    // Questo backup non e' opzionale: se non riusciamo a crearlo il restore
    // viene interrotto prima di toccare il database corrente.
    const safety = await createDatabaseBackup("pre-restore");
    restoreDatabaseFromFile(candidatePath, safety.backupPath);
    candidatePath = null; // spostato atomicamente in DB_PATH

    res.json({
      ok: true,
      restored: inspected,
      safety_backup: safety.backupName,
    });
  } catch (err) {
    next(err);
  } finally {
    if (candidatePath) fs.rmSync(candidatePath, { force: true });
  }
});

// Rotazione: conserva solo i BACKUP_KEEP file piu' recenti (0 = illimitato)
function pruneBackups(backupsDir) {
  if (!config.BACKUP_KEEP) return;
  try {
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.endsWith(".sqlite"))
      .map(f => ({ f, t: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);

    for (const { f } of files.slice(config.BACKUP_KEEP)) {
      fs.rmSync(path.join(backupsDir, f), { force: true });
    }
  } catch {
    // la rotazione non deve mai far fallire il backup
  }
}

module.exports = router;
