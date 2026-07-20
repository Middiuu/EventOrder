const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { pruneServiceData } = require("../src/service-data-retention");

test("la retention elimina solo audit scaduti e replay di turni chiusi", () => {
  const db = new Database(":memory:");
  db.exec(fs.readFileSync(path.join(__dirname, "..", "src", "schema.sql"), "utf8"));
  db.exec(`
    INSERT INTO cash_sessions (id, opened_at, closed_at) VALUES
      (1, '2026-01-01 00:00:00', '2026-01-01 01:00:00'),
      (2, '2026-01-01 00:00:00', NULL);
    INSERT INTO operation_requests
      (operation, request_id, request_fingerprint, session_id, response_json, created_at)
    VALUES
      ('cash_movement', 'old-closed', '${"a".repeat(64)}', 1, '{}', '2026-01-01 00:00:00'),
      ('cash_movement', 'new-closed', '${"b".repeat(64)}', 1, '{}', '2026-03-15 00:00:00'),
      ('cash_movement', 'old-opened', '${"c".repeat(64)}', 2, '{}', '2026-01-01 00:00:00');
    INSERT INTO audit_events (event_type, outcome, status_code, occurred_at) VALUES
      ('post:old', 'success', 200, '2025-12-31 00:00:00'),
      ('post:new', 'success', 200, '2026-03-15 00:00:00');
    INSERT INTO products (id, name, price_cents) VALUES (1, 'Storico', 500);
    INSERT INTO sales (id, sale_number, total_cents) VALUES (1, 1, 500);
    INSERT INTO sale_items
      (id, sale_id, product_id, qty, unit_price_cents, line_total_cents, product_name)
    VALUES (1, 1, 1, 1, 500, 500, 'Storico');
  `);

  const result = pruneServiceData(db, {
    auditRetentionDays: 90,
    operationRetentionDays: 30,
    nowMs: Date.parse("2026-04-01T00:00:00Z"),
  });

  assert.deepEqual(result, { auditEvents: 1, operationRequests: 1 });
  assert.deepEqual(
    db.prepare("SELECT request_id FROM operation_requests ORDER BY request_id").all(),
    [{ request_id: "new-closed" }, { request_id: "old-opened" }]
  );
  assert.deepEqual(db.prepare("SELECT event_type FROM audit_events").all(), [{ event_type: "post:new" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sales").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sale_items").get().count, 1);
  db.close();
});

test("retention zero conserva senza eccezioni tutti i record", () => {
  const database = {
    prepare: () => { throw new Error("non deve eseguire DELETE"); },
  };
  assert.deepEqual(pruneServiceData(database, {
    auditRetentionDays: 0,
    operationRetentionDays: 0,
  }), { auditEvents: 0, operationRequests: 0 });
});
