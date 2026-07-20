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
    const {
      db,
      initDb,
      DB_PATH,
      DB_BUSY_TIMEOUT_MS,
      SUPPORTED_MIGRATION_SOURCES,
    } = loadDbModule(dbPath);
    initDb();

    assert.equal(DB_PATH, dbPath);

    const productCount = db.prepare("SELECT COUNT(*) AS c FROM products").get().c;
    const saleCounter = db.prepare("SELECT int_value FROM app_state WHERE key = 'sale_number'").get();

    assert.equal(productCount, 4);
    assert.equal(saleCounter.int_value, 0);
    assert.equal(db.pragma("user_version", { simple: true }), 11);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='suspended_carts'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='suspended_cart_items'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='product_option_groups'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='product_option_values'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operation_requests'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sale_items_search'").get());
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(db.pragma("synchronous", { simple: true }), 2);
    assert.equal(db.pragma("busy_timeout", { simple: true }), DB_BUSY_TIMEOUT_MS);
    assert.deepEqual(SUPPORTED_MIGRATION_SOURCES, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("un database v11 con schema imitato viene rifiutato senza essere modificato", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  const Database = require("better-sqlite3");

  try {
    const malformed = new Database(dbPath);
    malformed.exec(`
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        name TEXT,
        price_cents INTEGER,
        category TEXT
      );
      INSERT INTO products VALUES (1, 'Prezzo impossibile', -500, 'Test');
      PRAGMA user_version = 11;
    `);
    malformed.close();

    const dbModule = loadDbModule(dbPath);
    assert.throws(
      () => dbModule.initDb(),
      /Database attivo non valido: schema SQLite non canonico.*products/i
    );
    assert.equal(dbModule.db.prepare("SELECT price_cents FROM products").get().price_cents, -500);
    assert.doesNotMatch(
      dbModule.db.prepare("SELECT sql FROM sqlite_master WHERE name='products'").get().sql,
      /CHECK\s*\(/i
    );
    assert.equal(
      dbModule.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='cash_sessions'").get().count,
      0
    );
    dbModule.db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("un database v11 canonico con dati fuori vincolo fallisce quick_check", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  const Database = require("better-sqlite3");

  try {
    const malformed = new Database(dbPath);
    malformed.exec(fs.readFileSync(path.join(__dirname, "..", "src", "schema.sql"), "utf8"));
    malformed.exec(`
      PRAGMA ignore_check_constraints = ON;
      INSERT INTO products (name, price_cents) VALUES ('Prezzo impossibile', -500);
      PRAGMA ignore_check_constraints = OFF;
      PRAGMA user_version = 11;
    `);
    malformed.close();

    const dbModule = loadDbModule(dbPath);
    assert.throws(
      () => dbModule.initDb(),
      /Database attivo non valido: quick_check.*products/i
    );
    assert.equal(dbModule.db.prepare("SELECT price_cents FROM products").get().price_cents, -500);
    dbModule.db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("un database v11 privo di un indice canonico viene rifiutato", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  const Database = require("better-sqlite3");

  try {
    const malformed = new Database(dbPath);
    malformed.exec(fs.readFileSync(path.join(__dirname, "..", "src", "schema.sql"), "utf8"));
    malformed.exec("DROP INDEX idx_products_active; PRAGMA user_version = 11;");
    malformed.close();

    const dbModule = loadDbModule(dbPath);
    assert.throws(
      () => dbModule.initDb(),
      /Database attivo non valido: schema SQLite non canonico.*idx_products_active/i
    );
    assert.equal(
      dbModule.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='idx_products_active'").get().count,
      0
    );
    dbModule.db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("un database v11 con relazioni orfane fallisce foreign_key_check", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  const Database = require("better-sqlite3");

  try {
    const malformed = new Database(dbPath);
    malformed.exec(fs.readFileSync(path.join(__dirname, "..", "src", "schema.sql"), "utf8"));
    malformed.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO sale_items (
        sale_id, product_id, qty, unit_price_cents, line_total_cents
      ) VALUES (999, 999, 1, 500, 500);
      PRAGMA user_version = 11;
    `);
    malformed.close();

    const dbModule = loadDbModule(dbPath);
    assert.throws(
      () => dbModule.initDb(),
      /Database attivo non valido: foreign_key_check.*sale_items/i
    );
    assert.equal(dbModule.db.prepare("SELECT COUNT(*) AS count FROM sale_items").get().count, 1);
    dbModule.db.close();
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
      SELECT product_name, product_category, stock_decremented_qty,
             base_unit_price_cents, options_json, note
      FROM sale_items WHERE id=1
    `).get();
    assert.deepEqual(item, {
      product_name: "Nome storico",
      product_category: "Cibo",
      stock_decremented_qty: 0,
      base_unit_price_cents: 500,
      options_json: "[]",
      note: null,
    });
    assert.equal(dbModule.db.pragma("user_version", { simple: true }), 11);
    assert.ok(dbModule.db.prepare("PRAGMA table_info(sales)").all().some(c => c.name === "session_id"));
    assert.ok(dbModule.db.prepare("PRAGMA table_info(sales)").all().some(c => c.name === "client_request_id"));
    assert.ok(dbModule.db.prepare("PRAGMA table_info(sales)").all().some(c => c.name === "request_fingerprint"));
    assert.ok(dbModule.db.prepare("PRAGMA table_info(sales)").all().some(c => c.name === "note"));
    assert.match(
      dbModule.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='products'").get().sql,
      /CHECK\s*\(/i
    );

    dbModule.db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrazione v4 preserva dati, sequenze, snapshot e applica i constraint canonici", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  const Database = require("better-sqlite3");

  try {
    const legacy = new Database(dbPath);
    legacy.exec(fs.readFileSync(path.join(__dirname, "..", "src", "schema.sql"), "utf8"));
    legacy.exec(`
      PRAGMA user_version = 4;
      INSERT INTO products
        (id, name, price_cents, category, sort_order, active, sold_out, stock, cost_cents)
      VALUES (7, 'Prodotto v4', 900, 'Test', 40, 1, 0, 12, 300);
      INSERT INTO products (id, name, price_cents) VALUES (100, 'Prodotto eliminato', 100);
      DELETE FROM products WHERE id = 100;
      INSERT INTO cash_sessions
        (id, opening_float_cents, operator)
      VALUES (5, 1000, 'Ada');
      INSERT INTO sales
        (id, sale_number, client_request_id, request_fingerprint, total_cents,
         payment_method, session_id)
      VALUES (11, 42, 'legacy-request', 'legacy-fingerprint', 1800, 'cash', 5);
      INSERT INTO sale_items
        (id, sale_id, product_id, qty, unit_price_cents, line_total_cents,
         product_name, product_category, product_cost_cents, stock_decremented_qty)
      VALUES (13, 11, 7, 2, 900, 1800, 'Prodotto v4', 'Test', 300, 2);
      INSERT INTO cash_movements
        (id, session_id, direction, amount_cents, reason, operator)
      VALUES (3, 5, 'in', 200, 'Resto', 'Ada');
      INSERT INTO app_state (key, int_value) VALUES ('sale_number', 42);
    `);
    legacy.close();

    const dbModule = loadDbModule(dbPath);
    dbModule.initDb();
    const migrated = dbModule.db;

    const migrationBackups = fs.readdirSync(path.join(tempDir, "backups"))
      .filter(name => /pre-migration-v4-to-v11-.*\.sqlite$/.test(name));
    assert.equal(migrationBackups.length, 1);
    const migrationBackupPath = path.join(tempDir, "backups", migrationBackups[0]);
    assert.equal(fs.statSync(migrationBackupPath).mode & 0o777, 0o600);
    const backup = new Database(migrationBackupPath, {
      readonly: true,
      fileMustExist: true,
    });
    assert.equal(backup.pragma("user_version", { simple: true }), 4);
    assert.equal(backup.prepare("SELECT name FROM products WHERE id = 7").get().name, "Prodotto v4");
    assert.deepEqual(backup.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    backup.close();
    assert.equal(fs.existsSync(dbModule.MIGRATION_MARKER_PATH), false);

    assert.equal(migrated.pragma("user_version", { simple: true }), 11);
    assert.deepEqual(
      migrated.prepare("SELECT rowid FROM sale_items_search WHERE sale_items_search MATCH ?").all("dotto"),
      [{ rowid: 13 }]
    );
    assert.equal(migrated.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(migrated.pragma("foreign_key_check"), []);
    assert.deepEqual(
      migrated.prepare(`
        SELECT id, product_name, product_category, product_cost_cents, stock_decremented_qty
        FROM sale_items WHERE id = 13
      `).get(),
      {
        id: 13,
        product_name: "Prodotto v4",
        product_category: "Test",
        product_cost_cents: 300,
        stock_decremented_qty: 2,
      }
    );
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM cash_movements").get().count, 1);
    assert.equal(migrated.prepare("SELECT int_value FROM app_state WHERE key='sale_number'").get().int_value, 42);
    assert.deepEqual(
      migrated.prepare(`
        SELECT print_status, print_attempts, last_print_error,
               last_print_attempt_at, last_printed_at
        FROM sales WHERE id = 11
      `).get(),
      {
        print_status: "printed",
        print_attempts: 1,
        last_print_error: null,
        last_print_attempt_at: migrated.prepare("SELECT created_at FROM sales WHERE id=11").get().created_at,
        last_printed_at: migrated.prepare("SELECT created_at FROM sales WHERE id=11").get().created_at,
      }
    );

    // Una seconda inizializzazione non ricopia i dati e non altera le sequenze.
    dbModule.initDb();
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM sales").get().count, 1);

    const invalidStatements = [
      "UPDATE products SET price_cents = -1 WHERE id = 7",
      "UPDATE products SET active = 2 WHERE id = 7",
      "UPDATE products SET stock = -1 WHERE id = 7",
      "UPDATE sales SET total_cents = -1 WHERE id = 11",
      "UPDATE sales SET payment_method = 'crypto' WHERE id = 11",
      "UPDATE sale_items SET qty = 0 WHERE id = 13",
      "UPDATE sale_items SET stock_decremented_qty = -1 WHERE id = 13",
      "UPDATE cash_sessions SET opening_float_cents = -1 WHERE id = 5",
      "UPDATE cash_movements SET direction = 'sideways' WHERE id = 3",
    ];
    for (const sql of invalidStatements) {
      assert.throws(() => migrated.exec(sql), /CHECK constraint failed/, sql);
    }
    assert.throws(
      () => migrated.exec("UPDATE sale_items SET sale_id = 999 WHERE id = 13"),
      /FOREIGN KEY constraint failed/
    );

    const inserted = migrated.prepare(`
      INSERT INTO products (name, price_cents) VALUES ('Dopo migrazione', 100)
    `).run();
    assert.equal(Number(inserted.lastInsertRowid), 101);
    assert.throws(
      () => migrated.prepare("INSERT INTO products (name, price_cents) VALUES (?, ?)")
        .run("  prodotto V4  ", 900),
      /UNIQUE constraint failed/
    );

    migrated.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("una migrazione incompatibile fa rollback e lascia intatte le tabelle legacy", () => {
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
      INSERT INTO products (name, price_cents) VALUES ('Dato incompatibile', -50);
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const dbModule = loadDbModule(dbPath);
    assert.throws(
      () => dbModule.initDb(),
      /Migrazione schema v4->v11 non riuscita: CHECK constraint failed/
    );
    assert.equal(dbModule.db.pragma("user_version", { simple: true }), 4);
    assert.equal(
      dbModule.db.prepare("SELECT price_cents FROM products WHERE id = 1").get().price_cents,
      -50
    );
    assert.doesNotMatch(
      dbModule.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='products'").get().sql,
      /CHECK\s*\(/i
    );
    assert.equal(
      dbModule.db.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type='table' AND name LIKE '__eventorder_migrate_%'
      `).get().count,
      0
    );
    assert.equal(fs.existsSync(dbModule.MIGRATION_MARKER_PATH), true);
    const migrationBackups = fs.readdirSync(path.join(tempDir, "backups"))
      .filter(name => /pre-migration-v4-to-v11-.*\.sqlite$/.test(name));
    assert.equal(migrationBackups.length, 1);
    dbModule.db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("la migrazione rifiuta una colonna legacy popolata senza mappatura", () => {
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
        legacy_label TEXT
      );
      INSERT INTO products (name, price_cents, legacy_label)
      VALUES ('Prodotto legacy', 500, 'Valore da non perdere');
      PRAGMA user_version = 8;
    `);
    legacy.close();

    const dbModule = loadDbModule(dbPath);
    assert.throws(
      () => dbModule.initDb(),
      /Colonna legacy popolata senza mappatura: products\.legacy_label/
    );
    assert.equal(dbModule.db.pragma("user_version", { simple: true }), 8);
    assert.equal(
      dbModule.db.prepare("SELECT legacy_label FROM products").get().legacy_label,
      "Valore da non perdere"
    );
    assert.equal(fs.existsSync(dbModule.MIGRATION_MARKER_PATH), true);
    dbModule.db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("un marker di migrazione recupera il backup e ripete il bump in sicurezza", () => {
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
      INSERT INTO products (name, price_cents) VALUES ('Prima del crash', 700);
      PRAGMA user_version = 4;
    `);
    legacy.close();

    let dbModule = loadDbModule(dbPath);
    dbModule.initDb();
    const safetyName = fs.readdirSync(path.join(tempDir, "backups"))
      .find(name => /pre-migration-v4-to-v11-.*\.sqlite$/.test(name));
    const safetyBackupPath = path.join(tempDir, "backups", safetyName);
    dbModule.closeDatabase();

    fs.writeFileSync(dbPath, "database lasciato corrotto da una migrazione interrotta");
    fs.writeFileSync(`${dbPath}.migration-state.json`, JSON.stringify({
      safetyBackupPath,
      fromVersion: 4,
      toVersion: 11,
      createdAt: new Date().toISOString(),
    }));

    dbModule = loadDbModule(dbPath);
    dbModule.initDb();
    assert.equal(dbModule.db.pragma("user_version", { simple: true }), 11);
    assert.ok(dbModule.db.prepare("SELECT 1 FROM products WHERE name = ?").get("Prima del crash"));
    assert.equal(fs.existsSync(dbModule.MIGRATION_MARKER_PATH), false);
    dbModule.closeDatabase();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("la migrazione non parte se il backup preventivo non puo' essere creato", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  const Database = require("better-sqlite3");

  try {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price_cents INTEGER NOT NULL
      );
      INSERT INTO products (name, price_cents) VALUES ('Da preservare', 500);
      PRAGMA user_version = 4;
    `);
    legacy.close();
    fs.writeFileSync(path.join(tempDir, "backups"), "impedisce la creazione della directory");

    const dbModule = loadDbModule(dbPath);
    assert.throws(() => dbModule.initDb(), /EEXIST|ENOTDIR/);
    assert.equal(dbModule.db.pragma("user_version", { simple: true }), 4);
    assert.equal(dbModule.db.prepare("SELECT name FROM products").get().name, "Da preservare");
    assert.equal(fs.existsSync(dbModule.MIGRATION_MARKER_PATH), false);
    dbModule.db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("marker concorrenti di restore e migrazione bloccano l'avvio", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");

  try {
    fs.writeFileSync(`${dbPath}.restore-state.json`, "{}");
    fs.writeFileSync(`${dbPath}.migration-state.json`, "{}");
    assert.throws(
      () => loadDbModule(dbPath),
      /Stato ambiguo: presenti marker di restore e migrazione/
    );
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rifiuta database creati da una versione futura senza modificarli", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  const Database = require("better-sqlite3");

  try {
    const future = new Database(dbPath);
    future.pragma("user_version = 99");
    future.close();

    const dbModule = loadDbModule(dbPath);
    assert.throws(() => dbModule.initDb(), /versione piu' recente \(99\)/);
    assert.equal(dbModule.db.pragma("user_version", { simple: true }), 99);
    dbModule.db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("un restore interrotto recupera automaticamente il backup di sicurezza", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  const backupsDir = path.join(tempDir, "backups");
  const safetyPath = path.join(backupsDir, "eventorder-pre-restore-test.sqlite");

  try {
    fs.mkdirSync(backupsDir);
    let dbModule = loadDbModule(dbPath);
    dbModule.initDb();
    dbModule.db.prepare("INSERT INTO products (name, price_cents) VALUES (?, ?)")
      .run("Presente nel backup sicuro", 700);
    await dbModule.db.backup(safetyPath);
    dbModule.db.prepare("INSERT INTO products (name, price_cents) VALUES (?, ?)")
      .run("Successivo al backup", 800);
    dbModule.db.close();

    fs.writeFileSync(dbPath, "database sostituito ma non valido");
    fs.writeFileSync(`${dbPath}.restore-state.json`, JSON.stringify({
      safetyBackupPath: safetyPath,
      createdAt: new Date().toISOString(),
    }));
    fs.writeFileSync(`${dbPath}-wal`, "sidecar WAL del database sostituito");
    fs.writeFileSync(`${dbPath}-shm`, "sidecar SHM del database sostituito");

    dbModule = loadDbModule(dbPath);
    dbModule.initDb();
    const names = dbModule.db.prepare("SELECT name FROM products ORDER BY id").all().map(row => row.name);
    assert.equal(names.includes("Presente nel backup sicuro"), true);
    assert.equal(names.includes("Successivo al backup"), false);
    assert.equal(fs.existsSync(`${dbPath}.restore-state.json`), false);
    dbModule.db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("recupera un restore legacy rimasto fra i due rename", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  const originalPath = `${dbPath}.restore-original-test`;

  try {
    let dbModule = loadDbModule(dbPath);
    dbModule.initDb();
    dbModule.db.prepare("INSERT INTO products (name, price_cents) VALUES (?, ?)")
      .run("Database originale", 900);
    dbModule.db.close();
    fs.renameSync(dbPath, originalPath);

    dbModule = loadDbModule(dbPath);
    dbModule.initDb();
    const recovered = dbModule.db.prepare("SELECT 1 FROM products WHERE name = ?")
      .get("Database originale");
    assert.ok(recovered);
    assert.equal(fs.existsSync(originalPath), false);
    dbModule.db.close();
  } finally {
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("il restore non sostituisce il DB se un lettore esterno blocca il checkpoint WAL", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-test-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  const backupsDir = path.join(tempDir, "backups");
  const safetyPath = path.join(backupsDir, "eventorder-pre-restore-test.sqlite");
  const candidatePath = path.join(tempDir, "candidate.sqlite");
  const Database = require("better-sqlite3");
  let reader;

  try {
    fs.mkdirSync(backupsDir);
    const dbModule = loadDbModule(dbPath);
    dbModule.initDb();
    dbModule.db.prepare("INSERT INTO products (name, price_cents) VALUES (?, ?)")
      .run("Database corrente", 700);
    await dbModule.db.backup(candidatePath);

    // Mantiene una snapshot precedente mentre la connessione principale
    // aggiunge una pagina WAL che il checkpoint non puo' ancora troncare.
    reader = new Database(dbPath, { readonly: true, fileMustExist: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS count FROM products").get();
    dbModule.db.prepare("INSERT INTO products (name, price_cents) VALUES (?, ?)")
      .run("Dato solo nel WAL corrente", 800);
    await dbModule.db.backup(safetyPath);

    let activeReaderError;
    try {
      dbModule.restoreDatabaseFromFile(candidatePath, safetyPath);
    } catch (err) {
      activeReaderError = err;
    }
    assert.match(activeReaderError?.message || "", /Checkpoint WAL occupato/);
    assert.equal(activeReaderError.status, 409);
    assert.match(activeReaderError.publicMessage, /chiudi altri programmi/);
    assert.equal(fs.existsSync(candidatePath), true);
    assert.equal(fs.existsSync(`${dbPath}.restore-state.json`), false);
    assert.ok(dbModule.db.prepare("SELECT 1 FROM products WHERE name=?")
      .get("Dato solo nel WAL corrente"));
    assert.equal(dbModule.db.pragma("journal_mode", { simple: true }), "wal");

    reader.exec("ROLLBACK");
    let idleReaderError;
    try {
      dbModule.restoreDatabaseFromFile(candidatePath, safetyPath);
    } catch (err) {
      idleReaderError = err;
    }
    assert.match(idleReaderError?.message || "", /SQLite e' ancora aperto in un altro programma/);
    assert.equal(idleReaderError.status, 409);
    assert.equal(fs.existsSync(candidatePath), true);
    assert.ok(dbModule.db.prepare("SELECT 1 FROM products WHERE name=?")
      .get("Dato solo nel WAL corrente"));

    reader.close();
    reader = null;
    dbModule.closeDatabase();
  } finally {
    try { reader?.close(); } catch {}
    delete process.env.POS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("nessun modulo conserva statement o transaction legati alla connessione sostituibile", () => {
  const srcDir = path.join(__dirname, "..", "src");
  const files = [
    path.join(srcDir, "db.js"),
    ...fs.readdirSync(path.join(srcDir, "routes"))
      .filter(name => name.endsWith(".js"))
      .map(name => path.join(srcDir, "routes", name)),
  ];
  const moduleScopeBinding = /^(?:const|let|var)\s+\w+\s*=\s*db\.(?:prepare|transaction)\s*\(/m;
  const moduleScopeCall = /^db\.(?:prepare|transaction)\s*\(/m;

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(moduleScopeBinding.test(source), false, path.relative(srcDir, file));
    assert.equal(moduleScopeCall.test(source), false, path.relative(srcDir, file));
  }
});
