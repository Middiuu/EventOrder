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
