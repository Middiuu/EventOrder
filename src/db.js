const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { config } = require("./config");

const DB_PATH = process.env.POS_DB_PATH
  ? path.resolve(process.env.POS_DB_PATH)
  : path.join(__dirname, "..", "pos.sqlite");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");
const DB_SCHEMA_VERSION = 4;

function openConnection() {
  const next = new Database(DB_PATH);
  next.pragma("foreign_keys = ON");
  return next;
}

let connection = openConnection();

// Le route conservano questo riferimento per tutta la vita del processo. Il
// proxy permette di sostituire in sicurezza la connessione dopo un restore,
// senza lasciare i moduli collegati a un Database ormai chiuso.
const db = new Proxy({}, {
  get(_target, property) {
    const value = connection[property];
    return typeof value === "function" ? value.bind(connection) : value;
  },
});

// Migrazioni idempotenti: aggiunge colonne mancanti su DB gia' esistenti,
// perche' "CREATE TABLE IF NOT EXISTS" non altera tabelle gia' presenti.
const EXPECTED_SALES_COLUMNS = {
  client_request_id: "TEXT",
  request_fingerprint: "TEXT",
  discount_cents: "INTEGER NOT NULL DEFAULT 0",
  discount_type: "TEXT",
  discount_value: "REAL",
  payment_method: "TEXT NOT NULL DEFAULT 'cash'",
  cash_received_cents: "INTEGER",
  change_cents: "INTEGER",
  operator: "TEXT",
  session_id: "INTEGER",
  void_reason: "TEXT",
  voided_at: "TEXT",
  void_operator: "TEXT",
};

const EXPECTED_SALE_ITEM_COLUMNS = {
  product_name: "TEXT NOT NULL DEFAULT ''",
  product_category: "TEXT NOT NULL DEFAULT 'Generale'",
  product_cost_cents: "INTEGER",
  stock_decremented_qty: "INTEGER NOT NULL DEFAULT 0",
};

const EXPECTED_PRODUCT_COLUMNS = {
  sold_out: "INTEGER NOT NULL DEFAULT 0",
  stock: "INTEGER",
  cost_cents: "INTEGER",
};

function tableExists(table) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
  `).get(table));
}

function addMissingColumns(table, expectedColumns) {
  if (!tableExists(table)) return;
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
  );
  for (const [name, definition] of Object.entries(expectedColumns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

function ensureMigratedColumns() {
  addMissingColumns("sales", EXPECTED_SALES_COLUMNS);
  addMissingColumns("sale_items", EXPECTED_SALE_ITEM_COLUMNS);
  addMissingColumns("products", EXPECTED_PRODUCT_COLUMNS);
}

function runMigrations() {
  const previousVersion = db.pragma("user_version", { simple: true });
  ensureMigratedColumns();

  // I database precedenti conservavano il nome solo nella tabella prodotti.
  // Lo copiamo una volta nelle righe storiche, che da ora restano immutabili.
  db.exec(`
    UPDATE sale_items
    SET product_category = COALESCE(
      (SELECT category FROM products WHERE id = sale_items.product_id),
      'Generale'
    )
    WHERE product_name = '';

    UPDATE sale_items
    SET product_name = COALESCE((SELECT name FROM products WHERE id = sale_items.product_id), '')
    WHERE product_name = '';
  `);

  if (previousVersion < 3) {
    // Le sole vendite legacy ancora stornabili appartengono al turno aperto.
    // Per queste righe deduciamo una volta se la scorta era presumibilmente
    // tracciata; tutte le nuove vendite fotografano il dato in modo esatto.
    db.exec(`
      UPDATE sale_items
      SET stock_decremented_qty = qty
      WHERE stock_decremented_qty = 0
        AND product_id IN (SELECT id FROM products WHERE stock IS NOT NULL)
        AND sale_id IN (
          SELECT s.id
          FROM sales s
          JOIN cash_sessions cs ON cs.id = s.session_id
          WHERE s.voided = 0 AND cs.closed_at IS NULL
        )
    `);
  }

  db.pragma(`user_version = ${DB_SCHEMA_VERSION}`);
}

function initDb() {
  // Le colonne vanno aggiunte prima degli indici definiti nello schema: su un
  // database vecchio, un CREATE INDEX che cita una colonna assente fallirebbe.
  ensureMigratedColumns();
  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schema);
  runMigrations();

  // seed demo generico se non ci sono prodotti (disattivabile con POS_SEED_DEMO=0)
  const count = db.prepare("SELECT COUNT(*) AS c FROM products").get().c;
  if (count === 0 && config.SEED_DEMO) {
    const ins = db.prepare(`
      INSERT INTO products (name, price_cents, category, sort_order)
      VALUES (@name, @price_cents, @category, @sort_order)
    `);
    const seed = [
      { name: "Prodotto A", price_cents: 500, category: "Generale", sort_order: 10 },
      { name: "Prodotto B", price_cents: 600, category: "Generale", sort_order: 20 },
      { name: "Prodotto C", price_cents: 350, category: "Generale", sort_order: 30 },
      { name: "Prodotto D", price_cents: 200, category: "Generale", sort_order: 40 },
    ];
    const tx = db.transaction(() => seed.forEach(r => ins.run(r)));
    tx();
  }

  const maxSaleNumber = db.prepare(`
    SELECT COALESCE(MAX(sale_number), 0) AS value
    FROM sales
  `).get().value;

  db.prepare(`
    INSERT INTO app_state (key, int_value)
    VALUES ('sale_number', ?)
    ON CONFLICT(key) DO UPDATE SET int_value = excluded.int_value
    WHERE app_state.int_value < excluded.int_value
  `).run(maxSaleNumber);
}

function getNextSaleNumber() {
  const row = db.prepare(`
    UPDATE app_state
    SET int_value = int_value + 1
    WHERE key = 'sale_number'
    RETURNING int_value
  `).get();

  if (!row) {
    throw new Error("Contatore sale_number non inizializzato");
  }

  return Number(row.int_value);
}

// Turno di cassa attualmente aperto (o undefined)
function getOpenSession() {
  return db.prepare(`
    SELECT * FROM cash_sessions
    WHERE closed_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `).get();
}

const REQUIRED_RESTORE_SCHEMA = {
  products: ["id", "name", "price_cents", "category"],
  cash_sessions: ["id", "opened_at", "closed_at", "opening_float_cents"],
  sales: ["id", "sale_number", "total_cents", "created_at"],
  sale_items: ["id", "sale_id", "product_id", "qty", "unit_price_cents", "line_total_cents"],
  app_state: ["key", "int_value"],
};

function restoreError(message) {
  const err = new Error(message);
  err.status = 400;
  err.publicMessage = message;
  return err;
}

// Apre il file separatamente e in sola lettura: nessun contenuto del backup
// viene eseguito o copiato prima che integrita' e identita' siano verificate.
function validateRestoreCandidate(candidatePath) {
  let candidate;
  try {
    candidate = new Database(candidatePath, { readonly: true, fileMustExist: true });

    const integrity = candidate.pragma("integrity_check");
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw restoreError("Il file SQLite non supera il controllo di integrita'");
    }

    const foreignKeyErrors = candidate.pragma("foreign_key_check");
    if (foreignKeyErrors.length > 0) {
      throw restoreError("Il backup contiene relazioni non valide");
    }

    // EventOrder non usa trigger o view. Rifiutarli evita che un file SQLite
    // estraneo possa eseguire effetti inattesi durante le migrazioni.
    const executableSchema = candidate.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE type IN ('trigger', 'view')
      LIMIT 1
    `).get();
    if (executableSchema) {
      throw restoreError("Il file non e' un backup EventOrder supportato");
    }

    for (const [table, requiredColumns] of Object.entries(REQUIRED_RESTORE_SCHEMA)) {
      const exists = candidate.prepare(`
        SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
      `).get(table);
      if (!exists) throw restoreError(`Backup non valido: tabella ${table} mancante`);

      const columns = new Set(candidate.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
      if (requiredColumns.some(column => !columns.has(column))) {
        throw restoreError(`Backup non valido: struttura ${table} non compatibile`);
      }
    }

    const userVersion = candidate.pragma("user_version", { simple: true });
    if (userVersion > DB_SCHEMA_VERSION) {
      throw restoreError("Il backup proviene da una versione piu' recente di EventOrder");
    }

    return {
      products: candidate.prepare("SELECT COUNT(*) AS count FROM products").get().count,
      sales: candidate.prepare("SELECT COUNT(*) AS count FROM sales").get().count,
      sessions: candidate.prepare("SELECT COUNT(*) AS count FROM cash_sessions").get().count,
      userVersion,
    };
  } catch (err) {
    if (err.status === 400) throw err;
    throw restoreError("Il file selezionato non e' un database SQLite EventOrder valido");
  } finally {
    candidate?.close();
  }
}

// Sostituzione atomica sullo stesso filesystem. Se apertura o migrazione del
// database ripristinato falliscono, il file originale viene rimesso al suo posto.
function restoreDatabaseFromFile(candidatePath) {
  const token = `${process.pid}-${Date.now()}`;
  const originalPath = `${DB_PATH}.restore-original-${token}`;
  let originalMoved = false;

  try {
    connection.close();
    fs.renameSync(DB_PATH, originalPath);
    originalMoved = true;
    fs.renameSync(candidatePath, DB_PATH);

    connection = openConnection();
    initDb();

    const foreignKeyErrors = db.pragma("foreign_key_check");
    if (foreignKeyErrors.length > 0) {
      throw new Error("Il database ripristinato non supera il controllo delle relazioni");
    }

    fs.rmSync(originalPath, { force: true });
    return;
  } catch (err) {
    try { connection.close(); } catch {}

    if (originalMoved) {
      try { fs.rmSync(DB_PATH, { force: true }); } catch {}
      fs.renameSync(originalPath, DB_PATH);
    }
    connection = openConnection();
    initDb();
    throw err;
  }
}

module.exports = {
  db,
  initDb,
  getNextSaleNumber,
  getOpenSession,
  validateRestoreCandidate,
  restoreDatabaseFromFile,
  DB_PATH,
};
