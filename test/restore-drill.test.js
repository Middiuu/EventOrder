const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const { createHarness } = require("./helpers/app-test-utils");

test("restore drill: backup verificato, restore, riavvio e invarianti", { timeout: 15000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-restore-drill-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  let firstHarness;
  let restartedHarness;
  let restoredInstanceId;
  let soldProduct;

  try {
    firstHarness = createHarness({ dbPath, printTicket: async () => {} });
    await firstHarness.withServer(async ({ request }) => {
      const product = (await request({ url: "/api/products" })).json()[0];
      soldProduct = { name: product.name, priceCents: product.price_cents };
      const beforeInstanceId = (await request({ url: "/api/sessions/current" }))
        .json().database_instance_id;

      assert.equal((await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0, operator: "Drill" }),
      })).status, 200);
      const sale = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{
            product_id: product.id,
            qty: 2,
            expected_unit_price_cents: product.price_cents,
          }],
          payment_method: "card",
        }),
      });
      assert.equal(sale.status, 200);
      assert.equal(sale.json().sale_number, 1);
      assert.equal((await request({
        method: "POST",
        url: "/api/sessions/close",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ counted_cash_cents: 0 }),
      })).status, 200);

      const created = await request({ method: "POST", url: "/api/reports/backup" });
      assert.equal(created.status, 201);
      const downloaded = await request({ url: created.json().download_url });
      assert.equal(downloaded.status, 200);

      const backupPath = path.join(tempDir, "backups", created.json().backup_name);
      const verified = new Database(backupPath, { readonly: true, fileMustExist: true });
      try {
        assert.equal(verified.pragma("user_version", { simple: true }), 11);
        assert.deepEqual(verified.pragma("integrity_check"), [{ integrity_check: "ok" }]);
        assert.deepEqual(verified.pragma("foreign_key_check"), []);
        assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM sales").get().count, 1);
      } finally {
        verified.close();
      }

      const marker = await request({
        method: "POST",
        url: "/api/products",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Sentinella post-backup", price_cents: 123 }),
      });
      assert.equal(marker.status, 200);

      const restored = await request({
        method: "POST",
        url: "/api/reports/restore",
        headers: {
          "Content-Type": "application/vnd.sqlite3",
          "X-EventOrder-Restore": "RESTORE",
        },
        body: downloaded.buffer,
      });
      assert.equal(restored.status, 200, restored.text);
      assert.equal(restored.json().ok, true);
      assert.equal(restored.json().restored.sales, 1);

      const current = (await request({ url: "/api/sessions/current" })).json();
      restoredInstanceId = current.database_instance_id;
      assert.notEqual(restoredInstanceId, beforeInstanceId);
      assert.equal(current.session, null);
    });
    firstHarness.cleanup();
    firstHarness = null;

    restartedHarness = createHarness({ dbPath, printTicket: async () => {} });
    await restartedHarness.withServer(async ({ request }) => {
      const ready = await request({ url: "/api/health/ready" });
      assert.equal(ready.status, 200);
      assert.equal(ready.json().schema_version, 11);

      const products = (await request({ url: "/api/products/all" })).json();
      assert.equal(products.some(product => product.name === "Sentinella post-backup"), false);

      const history = (await request({ url: "/api/sales?paginated=1" })).json().sales;
      assert.equal(history.length, 1);
      assert.equal(history[0].sale_number, 1);
      assert.equal(history[0].items[0].qty, 2);
      assert.equal(history[0].items[0].name, soldProduct.name);
      assert.equal(history[0].items[0].unit_price_cents, soldProduct.priceCents);

      const current = (await request({ url: "/api/sessions/current" })).json();
      assert.equal(current.session, null);
      assert.equal(current.database_instance_id, restoredInstanceId);
    });

    const database = require("../src/db").db;
    assert.equal(database.pragma("user_version", { simple: true }), 11);
    assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
    assert.deepEqual(database.pragma("quick_check"), [{ quick_check: "ok" }]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    firstHarness?.cleanup();
    restartedHarness?.cleanup();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
