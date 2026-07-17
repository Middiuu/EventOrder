const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

function loadDbModule(dbPath) {
  process.env.POS_DB_PATH = dbPath;
  const modulePath = require.resolve("../src/db");
  delete require.cache[modulePath];
  return require("../src/db");
}

test("initDb crea schema, seed iniziale e contatore vendite", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");

  try {
    const { db, initDb, DB_PATH } = loadDbModule(dbPath);
    initDb();

    assert.equal(DB_PATH, dbPath);

    const productCount = db.prepare("SELECT COUNT(*) AS c FROM products").get().c;
    const saleCounter = db.prepare("SELECT int_value FROM app_state WHERE key = 'sale_number'").get();

    assert.equal(productCount, 4);
    assert.equal(saleCounter.int_value, 0);

    db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("getNextSaleNumber incrementa in modo progressivo e resta allineato alle vendite esistenti", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");

  try {
    let dbModule = loadDbModule(dbPath);
    dbModule.initDb();

    assert.equal(dbModule.getNextSaleNumber(), 1);
    assert.equal(dbModule.getNextSaleNumber(), 2);

    dbModule.db.prepare(`
      INSERT INTO sales (sale_number, total_cents, voided)
      VALUES (8, 1500, 0)
    `).run();

    dbModule.db.close();

    dbModule = loadDbModule(dbPath);
    dbModule.initDb();

    assert.equal(dbModule.getNextSaleNumber(), 9);

    dbModule.db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrazione legacy aggiunge e valorizza gli snapshot prodotto prima di creare gli indici", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  const Database = require("better-sqlite3");

  try {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        category TEXT NOT NULL DEFAULT 'Generale',
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_number INTEGER NOT NULL,
        total_cents INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        voided INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sale_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        qty INTEGER NOT NULL,
        unit_price_cents INTEGER NOT NULL,
        line_total_cents INTEGER NOT NULL
      );
      INSERT INTO products (name, price_cents, category) VALUES ('Nome storico', 500, 'Cibo');
      INSERT INTO sales (sale_number, total_cents) VALUES (1, 500);
      INSERT INTO sale_items (sale_id, product_id, qty, unit_price_cents, line_total_cents)
      VALUES (1, 1, 1, 500, 500);
    `);
    legacy.close();

    const dbModule = loadDbModule(dbPath);
    dbModule.initDb();

    const item = dbModule.db.prepare(`
      SELECT product_name, product_category, stock_decremented_qty FROM sale_items WHERE id=1
    `).get();
    assert.deepEqual(item, {
      product_name: "Nome storico",
      product_category: "Cibo",
      stock_decremented_qty: 0,
    });
    assert.equal(dbModule.db.pragma("user_version", { simple: true }), 4);
    assert.ok(dbModule.db.prepare("PRAGMA table_info(sales)").all().some(c => c.name === "session_id"));
    assert.ok(dbModule.db.prepare("PRAGMA table_info(sales)").all().some(c => c.name === "client_request_id"));
    assert.ok(dbModule.db.prepare("PRAGMA table_info(sales)").all().some(c => c.name === "request_fingerprint"));

    dbModule.db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
