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
function runMigrations() {
  const expectedSalesColumns = {
    payment_method: "TEXT NOT NULL DEFAULT 'cash'",
    cash_received_cents: "INTEGER",
    change_cents: "INTEGER",
    operator: "TEXT",
    session_id: "INTEGER",
    void_reason: "TEXT",
  };

  const existing = new Set(
    db.prepare("PRAGMA table_info(sales)").all().map(c => c.name)
  );

  for (const [name, definition] of Object.entries(expectedSalesColumns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE sales ADD COLUMN ${name} ${definition}`);
    }
  }
}

function initDb() {
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
