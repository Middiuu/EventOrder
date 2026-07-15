const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { config } = require("./config");

const DB_PATH = process.env.POS_DB_PATH
  ? path.resolve(process.env.POS_DB_PATH)
  : path.join(__dirname, "..", "pos.sqlite");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

// Migrazioni idempotenti: aggiunge colonne mancanti su DB gia' esistenti,
// perche' "CREATE TABLE IF NOT EXISTS" non altera tabelle gia' presenti.
const EXPECTED_SALES_COLUMNS = {
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

  db.pragma("user_version = 2");
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

module.exports = { db, initDb, getNextSaleNumber, getOpenSession, DB_PATH };
