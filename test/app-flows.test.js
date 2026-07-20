const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createHarness } = require("./helpers/app-test-utils");

test("flusso prodotti: seed, creazione, unicita', update e filtro attivi", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ request }) => {
      const initial = await request({ url: "/api/products" });
      assert.equal(initial.status, 200);
      assert.equal(initial.json().length, 4);

      const created = await request({
        method: "POST",
        url: "/api/products",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Birra Artigianale",
          category: "Extra",
          price_cents: 700,
          sort_order: 30,
          active: 1,
        }),
      });

      assert.equal(created.status, 200);
      const createdId = created.json().id;
      assert.ok(createdId > 0);

      const duplicate = await request({
        method: "POST",
        url: "/api/products",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: " birra artigianale ",
          category: "Extra",
          price_cents: 700,
        }),
      });

      assert.equal(duplicate.status, 409);

      const updated = await request({
        method: "PATCH",
        url: `/api/products/${createdId}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Birra Speciale",
          price_cents: 750,
          active: 0,
        }),
      });

      assert.equal(updated.status, 200);
      assert.equal(updated.json().ok, true);

      const activeOnly = await request({ url: "/api/products" });
      assert.equal(activeOnly.status, 200);
      assert.equal(activeOnly.json().some((p) => p.id === createdId), false);

      const allProducts = await request({ url: "/api/products/all" });
      const saved = allProducts.json().find((p) => p.id === createdId);
      assert.equal(saved.name, "Birra Speciale");
      assert.equal(saved.price_cents, 750);
      assert.equal(saved.active, 0);
    });
  } finally {
    harness.cleanup();
  }
});

test("flussi vendite, report, export, backup e annullo funzionano insieme", async () => {
  const printed = [];
  const harness = createHarness({
    printTicket: async (payload) => {
      printed.push(payload);
    },
  });

  try {
    await harness.withServer(async ({ request }) => {
      const productsRes = await request({ url: "/api/products" });
      const product = productsRes.json()[0];

      // senza turno aperto la vendita e' rifiutata
      const noSession = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ product_id: product.id, qty: 1 }] }),
      });
      assert.equal(noSession.status, 409);

      // apertura turno con fondo cassa
      const openRes = await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 5000, operator: "Anna" }),
      });
      assert.equal(openRes.status, 200);

      const total = product.price_cents * 2;
      const saleRes = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ product_id: product.id, qty: 2 }],
          payment_method: "cash",
          cash_received_cents: total + 500,
        }),
      });

      assert.equal(saleRes.status, 200);
      const saleBody = saleRes.json();
      assert.equal(saleBody.ok, true);
      assert.equal(saleBody.sale_number, 1);
      assert.equal(saleBody.total_cents, total);
      assert.equal(saleBody.change_cents, 500);

      assert.equal(printed.length, 1);
      assert.equal(printed[0].saleNumber, 1);
      assert.equal(printed[0].operator, "Anna");
      assert.equal(printed[0].changeCents, 500);

      const todayRes = await request({ url: "/api/reports/today" });
      const today = todayRes.json();
      assert.equal(today.summary.sales_count, 1);
      assert.equal(today.summary.revenue_cents, product.price_cents * 2);
      assert.equal(today.byProduct[0].qty_sold, 2);

      const pad2 = (n) => String(n).padStart(2, "0");
      const localYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const todayYmd = localYmd(new Date());
      const tomorrow = localYmd(new Date(Date.now() + 86400000));
      const exportRes = await request({
        url: `/api/reports/export.csv?from=${todayYmd}&to=${tomorrow}`,
      });

      assert.equal(exportRes.status, 200);
      assert.match(exportRes.text, /total_revenue_eur/);
      assert.match(exportRes.text, new RegExp(product.name));

      const backupCreated = await request({ method: "POST", url: "/api/reports/backup" });
      assert.equal(backupCreated.status, 201);
      const backupRes = await request({ url: backupCreated.json().download_url });
      assert.equal(backupRes.status, 200);
      assert.match(String(backupRes.headers["content-disposition"]), /-backup-\d{8}-/);
      assert.ok(backupRes.buffer.length > 0);
      assert.equal(Number(backupRes.headers["content-length"]), backupRes.buffer.length);
      assert.equal(backupCreated.json().size_bytes, backupRes.buffer.length);
      assert.equal(backupRes.headers["cache-control"], "no-store");
      const migrationName = "eventorder-pre-migration-v4-to-v11-20260720-120000.sqlite";
      fs.writeFileSync(path.join(harness.tempDir, "backups", migrationName), backupRes.buffer);
      const migrationBackup = await request({
        url: `/api/reports/backup/${migrationName}`,
      });
      assert.equal(migrationBackup.status, 200);
      assert.equal(migrationBackup.buffer.length, backupRes.buffer.length);
      const unsafeGet = await request({ url: "/api/reports/backup" });
      assert.equal(unsafeGet.status, 405);
      assert.equal(unsafeGet.headers.allow, "POST");

      const voidRes = await request({
        method: "POST",
        url: "/api/sales/void-last",
      });
      assert.equal(voidRes.status, 200);
      assert.equal(voidRes.json().sale_number, 1);

      const afterVoidRes = await request({ url: "/api/reports/today" });
      const afterVoid = afterVoidRes.json();
      assert.equal(afterVoid.summary.sales_count, 0);
      assert.equal(afterVoid.summary.revenue_cents, 0);
      assert.equal(afterVoid.byProduct.length, 0);

      // chiusura turno: nessuna vendita valida -> atteso = solo fondo cassa (5000)
      const closeRes = await request({
        method: "POST",
        url: "/api/sessions/close",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ counted_cash_cents: 5000 }),
      });
      assert.equal(closeRes.status, 200);
      const closed = closeRes.json().session;
      assert.equal(closed.expected_cash_cents, 5000);
      assert.equal(closed.difference_cents, 0);
      assert.ok(closed.closed_at);
    });
  } finally {
    harness.cleanup();
  }
});

test("idempotenza incasso: un retry restituisce la stessa vendita senza ristampa o duplicati", async () => {
  const printed = [];
  const harness = createHarness({ printTicket: async payload => printed.push(payload) });

  try {
    await harness.withServer(async ({ request }) => {
      const created = await request({
        method: "POST",
        url: "/api/products",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Prodotto idempotente", price_cents: 500, stock: 5 }),
      });
      const product = (await request({ url: "/api/products/all" })).json()
        .find(p => p.id === created.json().id);
      assert.equal((await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0, operator: "Anna" }),
      })).status, 200);

      const key = "checkout-test-0001";
      const body = JSON.stringify({
        items: [{ product_id: product.id, qty: 2 }],
        payment_method: "card",
      });
      const send = (payload = body) => request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: payload,
      });

      const first = await send();
      const retry = await send();
      assert.equal(first.status, 200);
      assert.equal(retry.status, 200);
      assert.equal(retry.json().idempotent_replay, true);
      assert.equal(retry.json().sale_number, first.json().sale_number);
      assert.equal(printed.length, 1);

      const sales = (await request({ url: "/api/sales?limit=50" })).json();
      assert.equal(sales.length, 1);
      const stockAfterRetry = (await request({ url: "/api/products/all" })).json()
        .find(p => p.id === product.id).stock;
      assert.equal(stockAfterRetry, 3);

      const changedPayload = JSON.stringify({
        items: [{ product_id: product.id, qty: 1 }],
        payment_method: "card",
      });
      const conflict = await send(changedPayload);
      assert.equal(conflict.status, 409);
      assert.match(conflict.json().error, /richiesta diversa/);

      const invalidKey = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "bad" },
        body,
      });
      assert.equal(invalidKey.status, 400);

      assert.equal((await request({
        method: "POST",
        url: "/api/sessions/close",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ counted_cash_cents: 0 }),
      })).status, 200);
      const retryAfterClose = await send();
      assert.equal(retryAfterClose.status, 200);
      assert.equal(retryAfterClose.json().idempotent_replay, true);
      assert.equal(printed.length, 1);
    });
  } finally {
    harness.cleanup();
  }
});

test("ripresa dopo crash: una stampa persistita come pending richiede una ristampa esplicita", async () => {
  const printed = [];
  const harness = createHarness({ printTicket: async payload => printed.push(payload) });

  try {
    await harness.withServer(async ({ request }) => {
      const product = (await request({ url: "/api/products" })).json()[0];
      assert.equal((await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0, operator: "Anna" }),
      })).status, 200);

      const key = "checkout-crash-recovery-0001";
      const body = JSON.stringify({
        items: [{ product_id: product.id, qty: 1 }],
        payment_method: "card",
      });
      const send = () => request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body,
      });

      const first = await send();
      assert.equal(first.status, 200);
      assert.equal(printed.length, 1);

      // Simula il dato lasciato da un processo terminato durante la stampa:
      // la vendita e' gia' contabilizzata, ma l'esito non e' noto.
      const { db } = require("../src/db");
      db.prepare(`
        UPDATE sales
        SET print_status = 'pending', last_printed_at = NULL
        WHERE sale_number = ?
      `).run(first.json().sale_number);

      const retry = await send();
      assert.equal(retry.status, 409);
      assert.equal(retry.json().sale_recorded, true);
      assert.equal(retry.json().print_status, "pending");
      assert.equal(retry.json().sale_number, first.json().sale_number);
      assert.equal(printed.length, 1);

      const sales = (await request({ url: "/api/sales?limit=50" })).json();
      assert.equal(sales.length, 1);
      assert.equal(sales[0].print_status, "pending");
      assert.equal(sales[0].can_reprint, true);

      const reprint = await request({
        method: "POST",
        url: `/api/sales/${sales[0].id}/reprint`,
      });
      assert.equal(reprint.status, 200);
      assert.equal(reprint.json().print_status, "printed");
      assert.equal(reprint.json().print_attempts, 2);
      assert.equal(printed.length, 2);
    });
  } finally {
    harness.cleanup();
  }
});

test("restore backup: valida il file, blocca il turno aperto e sostituisce il DB senza riavvio", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const createProduct = (name) => request({
        method: "POST",
        url: "/api/products",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, price_cents: 450, category: "Test" }),
      });

      assert.equal((await createProduct("Presente nel backup")).status, 200);
      const instanceBeforeRestore = (await request({
        url: "/api/sessions/current",
      })).json().database_instance_id;
      const backupCreated = await request({ method: "POST", url: "/api/reports/backup" });
      assert.equal(backupCreated.status, 201);
      const backup = await request({ url: backupCreated.json().download_url });
      assert.equal(backup.status, 200);
      assert.equal((await createProduct("Creato dopo il backup")).status, 200);

      const restoreHeaders = {
        "Content-Type": "application/octet-stream",
        "X-EventOrder-Restore": "RESTORE",
      };
      const unsupported = await request({
        method: "POST",
        url: "/api/reports/restore",
        headers: {
          "Content-Type": "text/plain",
          "X-EventOrder-Restore": "RESTORE",
        },
        body: Buffer.from("non sqlite"),
      });
      assert.equal(unsupported.status, 415);
      const invalid = await request({
        method: "POST",
        url: "/api/reports/restore",
        headers: restoreHeaders,
        body: Buffer.from("non e' sqlite"),
      });
      assert.equal(invalid.status, 400);
      assert.match(invalid.json().error, /SQLite EventOrder valido/);
      assert.equal(
        fs.readdirSync(harness.tempDir).some(name => name.includes("restore-upload")),
        false
      );

      assert.equal((await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0 }),
      })).status, 200);
      const blocked = await request({
        method: "POST",
        url: "/api/reports/restore",
        headers: restoreHeaders,
        body: backup.buffer,
      });
      assert.equal(blocked.status, 409);
      assert.match(blocked.json().error, /Chiudi la cassa/);
      assert.equal((await request({
        method: "POST",
        url: "/api/sessions/close",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ counted_cash_cents: 0 }),
      })).status, 200);

      const restored = await request({
        method: "POST",
        url: "/api/reports/restore",
        headers: restoreHeaders,
        body: backup.buffer,
      });
      assert.equal(restored.status, 200);
      const restoredBody = restored.json();
      assert.equal(restoredBody.ok, true);
      assert.ok(restoredBody.safety_backup.includes("pre-restore"));
      assert.equal(
        fs.existsSync(path.join(harness.tempDir, "backups", restoredBody.safety_backup)),
        true
      );

      const products = (await request({ url: "/api/products/all" })).json();
      assert.equal(products.some(p => p.name === "Presente nel backup"), true);
      assert.equal(products.some(p => p.name === "Creato dopo il backup"), false);
      const instanceAfterRestore = (await request({
        url: "/api/sessions/current",
      })).json().database_instance_id;
      assert.notEqual(instanceAfterRestore, instanceBeforeRestore);

      // Le route devono usare subito la nuova connessione, incluse le
      // transazioni di vendita e storno create prima del restore.
      assert.equal((await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0 }),
      })).status, 200);
      const product = products.find(p => p.name === "Presente nel backup");
      const sale = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "post-restore-sale-0001",
        },
        body: JSON.stringify({ items: [{ product_id: product.id, qty: 1 }], payment_method: "card" }),
      });
      assert.equal(sale.status, 200);
      const voided = await request({ method: "POST", url: "/api/sales/void-last" });
      assert.equal(voided.status, 200);
      assert.equal(voided.json().sale_number, sale.json().sale_number);
    });
  } finally {
    harness.cleanup();
  }
});

test("restore rifiuta un database v11 non canonico con dati fuori vincolo", async () => {
  const harness = createHarness();
  const candidatePath = path.join(harness.tempDir, "malformed-v10.sqlite");
  const Database = require("better-sqlite3");

  try {
    const candidate = new Database(candidatePath);
    candidate.exec(`
      CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price_cents INTEGER, category TEXT);
      CREATE TABLE cash_sessions (id INTEGER PRIMARY KEY, opened_at TEXT, closed_at TEXT, opening_float_cents INTEGER);
      CREATE TABLE sales (id INTEGER PRIMARY KEY, sale_number INTEGER, total_cents INTEGER, created_at TEXT);
      CREATE TABLE sale_items (id INTEGER PRIMARY KEY, sale_id INTEGER, product_id INTEGER, qty INTEGER, unit_price_cents INTEGER, line_total_cents INTEGER);
      CREATE TABLE app_state (key TEXT PRIMARY KEY, int_value INTEGER);
      INSERT INTO products VALUES (1, 'Prezzo impossibile', -500, 'Test');
      INSERT INTO app_state VALUES ('sale_number', 0);
      PRAGMA user_version = 11;
    `);
    candidate.close();

    await harness.withServer(async ({ request }) => {
      const before = (await request({ url: "/api/products" })).json().length;
      const restored = await request({
        method: "POST",
        url: "/api/reports/restore",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-EventOrder-Restore": "RESTORE",
        },
        body: fs.readFileSync(candidatePath),
      });
      assert.equal(restored.status, 400);
      assert.match(restored.json().error, /schema o dati non compatibili/i);
      assert.equal((await request({ url: "/api/products" })).json().length, before);
    });
  } finally {
    harness.cleanup();
  }
});

test("la manutenzione di restore blocca tutte le route che usano il database", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ request }) => {
      const maintenance = require("../src/maintenance");
      assert.equal(maintenance.beginRestore(), true);
      try {
        const read = await request({ url: "/api/products" });
        assert.equal(read.status, 503);
        assert.equal(read.headers["retry-after"], "2");

        // La configurazione pubblica non usa il DB e resta disponibile.
        const config = await request({ url: "/api/config" });
        assert.equal(config.status, 200);

        const write = await request({
          method: "POST",
          url: "/api/sessions/open",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ opening_float_cents: 0 }),
        });
        assert.equal(write.status, 503);
        assert.equal(write.headers["retry-after"], "2");
        assert.match(write.json().error, /Ripristino/);
      } finally {
        maintenance.endRestore();
      }

      const after = await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0 }),
      });
      assert.equal(after.status, 200);
    });
  } finally {
    harness.cleanup();
  }
});

test("un restore non puo' iniziare mentre un backup e' in corso", async () => {
  const Database = require("better-sqlite3");
  const originalBackup = Database.prototype.backup;
  let signalStarted;
  let releaseBackup;
  const backupStarted = new Promise(resolve => { signalStarted = resolve; });
  const backupCanFinish = new Promise(resolve => { releaseBackup = resolve; });

  Database.prototype.backup = async function delayedBackup(...args) {
    signalStarted();
    await backupCanFinish;
    return originalBackup.apply(this, args);
  };

  const harness = createHarness();
  try {
    await harness.withServer(async ({ request }) => {
      const backupRequest = request({ method: "POST", url: "/api/reports/backup" });
      await backupStarted;

      try {
        const secondBackup = await request({ method: "POST", url: "/api/reports/backup" });
        assert.equal(secondBackup.status, 503);
        assert.equal(secondBackup.headers["retry-after"], "2");
        assert.match(secondBackup.json().error, /backup o ripristino/i);

        const restore = await request({
          method: "POST",
          url: "/api/reports/restore",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-EventOrder-Restore": "RESTORE",
          },
          body: Buffer.from("contenuto irrilevante: il lock precede il parser"),
        });
        assert.equal(restore.status, 409);
        assert.match(restore.json().error, /backup o ripristino/i);
      } finally {
        // Evita di lasciare la richiesta appesa anche se un'asserzione fallisce.
        releaseBackup();
      }

      const backup = await backupRequest;
      assert.equal(backup.status, 201);
    });
  } finally {
    releaseBackup();
    Database.prototype.backup = originalBackup;
    harness.cleanup();
  }
});

test("GET /api/config espone branding, valuta e locale al frontend", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ request }) => {
      const res = await request({ url: "/api/config" });
      assert.equal(res.status, 200);
      const cfg = res.json();
      assert.ok(typeof cfg.appName === "string" && cfg.appName.length > 0);
      assert.ok(typeof cfg.businessName === "string" && cfg.businessName.length > 0);
      assert.ok(typeof cfg.currencySymbol === "string" && cfg.currencySymbol.length > 0);
      assert.equal(cfg.currencyCode, "EUR");
      assert.ok(typeof cfg.locale === "string" && cfg.locale.length > 0);
    });
  } finally {
    harness.cleanup();
  }
});

test("health check e request ID restano disponibili senza autenticazione", async () => {
  const harness = createHarness({ env: { APP_PIN: "1234" } });

  try {
    await harness.withServer(async ({ request }) => {
      const generated = await request({ url: "/api/health" });
      assert.equal(generated.status, 200);
      assert.match(generated.headers["x-request-id"], /^[0-9a-f-]{36}$/);
      assert.deepEqual(generated.json(), {
        status: "ok",
        version: "1.0.0",
        schema_version: 11,
      });

      const correlated = await request({
        url: "/api/config",
        headers: { "X-Request-ID": "tablet-cassa-001" },
      });
      assert.equal(correlated.headers["x-request-id"], "tablet-cassa-001");

      const replaced = await request({
        url: "/api/config",
        headers: { "X-Request-ID": "invalid id with spaces" },
      });
      assert.notEqual(replaced.headers["x-request-id"], "invalid id with spaces");
    });
  } finally {
    harness.cleanup();
  }
});

test("audit trail registra esito e request ID delle mutazioni senza salvarne il payload", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ request }) => {
      const response = await request({
        method: "POST",
        url: "/api/products",
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": "audit-product-001",
        },
        body: JSON.stringify({
          name: "Segreto da non copiare nell'audit",
          price_cents: 450,
          active: 1,
        }),
      });
      assert.equal(response.status, 200);

      const { db } = require("../src/db");
      const event = db.prepare(`
        SELECT event_type, outcome, status_code, request_id FROM audit_events ORDER BY id DESC LIMIT 1
      `).get();
      assert.deepEqual(event, {
        event_type: "post:products",
        outcome: "success",
        status_code: 200,
        request_id: "audit-product-001",
      });
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_events'").get().sql;
      assert.doesNotMatch(schema, /payload|body|cookie|pin/i);
    });
  } finally {
    harness.cleanup();
  }
});

test("riepilogo shell conta dal DB senza caricare catalogo o limitare le vendite a 500", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ request }) => {
      const initial = await request({ url: "/api/shell/summary" });
      assert.equal(initial.status, 200);
      assert.deepEqual(initial.json(), {
        active_products: 4,
        valid_sales: 0,
      });

      assert.equal((await request({
        method: "POST",
        url: "/api/products",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Attivo nel badge", price_cents: 100, active: 1 }),
      })).status, 200);
      assert.equal((await request({
        method: "POST",
        url: "/api/products",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Fuori dal badge", price_cents: 100, active: 0 }),
      })).status, 200);

      // Il vecchio frontend richiedeva /api/sales?limit=500: con 501 vendite
      // il badge risultava inevitabilmente troncato.
      const { db } = require("../src/db");
      const insertSale = db.prepare(`
        INSERT INTO sales (sale_number, total_cents, voided)
        VALUES (?, 100, 0)
      `);
      db.transaction(() => {
        for (let saleNumber = 1; saleNumber <= 501; saleNumber += 1) {
          insertSale.run(saleNumber);
        }
      })();

      const populated = await request({ url: "/api/shell/summary" });
      assert.deepEqual(populated.json(), {
        active_products: 5,
        valid_sales: 501,
      });

      db.prepare("UPDATE sales SET voided=1 WHERE sale_number=501").run();
      assert.deepEqual((await request({ url: "/api/shell/summary" })).json(), {
        active_products: 5,
        valid_sales: 500,
      });
    });
  } finally {
    harness.cleanup();
  }
});

test("POST /api/products/reorder aggiorna sort_order in modo atomico", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ request }) => {
      const before = (await request({ url: "/api/products/all" })).json();
      assert.ok(before.length >= 2);

      // ordine invertito rispetto a quello corrente
      const reversedIds = before.map((p) => p.id).reverse();

      const res = await request({
        method: "POST",
        url: "/api/products/reorder",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: reversedIds }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.json().ok, true);

      const after = (await request({ url: "/api/products/all" })).json();
      // il primo dell'ordine inviato deve avere sort_order = 10
      const first = after.find((p) => p.id === reversedIds[0]);
      assert.equal(first.sort_order, 10);
      // l'elenco (ordinato per sort_order) deve rispettare il nuovo ordine
      const activeOrder = after
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((p) => p.id);
      assert.deepEqual(activeOrder.slice(0, reversedIds.length), reversedIds);

      // input non valido -> 400
      const bad = await request({
        method: "POST",
        url: "/api/products/reorder",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: [] }),
      });
      assert.equal(bad.status, 400);

      // id inesistente -> 400 e nessun riordino applicato
      const ghost = await request({
        method: "POST",
        url: "/api/products/reorder",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: [...reversedIds, 99999] }),
      });
      assert.equal(ghost.status, 400);

      // id duplicato -> 400
      const dup = await request({
        method: "POST",
        url: "/api/products/reorder",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: [reversedIds[0], reversedIds[0]] }),
      });
      assert.equal(dup.status, 400);
    });
  } finally {
    harness.cleanup();
  }
});

test("eliminazione prodotti: consentita solo se mai venduti", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const products = (await request({ url: "/api/products" })).json();
      const soldProduct = products[0];

      // prodotto mai venduto -> eliminazione ok
      const created = await request({
        method: "POST",
        url: "/api/products",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Prodotto Temporaneo", price_cents: 100 }),
      });
      const tempId = created.json().id;

      const deleted = await request({ method: "DELETE", url: `/api/products/${tempId}` });
      assert.equal(deleted.status, 200);
      const all = (await request({ url: "/api/products/all" })).json();
      assert.equal(all.some((p) => p.id === tempId), false);

      // prodotto con vendite registrate -> 409
      await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0 }),
      });
      await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ product_id: soldProduct.id, qty: 1 }] }),
      });

      const conflict = await request({ method: "DELETE", url: `/api/products/${soldProduct.id}` });
      assert.equal(conflict.status, 409);
      assert.match(conflict.json().error, /disattivalo/);

      // prodotto inesistente -> 404
      const missing = await request({ method: "DELETE", url: "/api/products/99999" });
      assert.equal(missing.status, 404);
    });
  } finally {
    harness.cleanup();
  }
});

test("turno di cassa: chiusura calcola contanti attesi e differenza", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const product = (await request({ url: "/api/products" })).json()[0];

      await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 10000 }),
      });

      // due turni aperti non sono ammessi
      const dupOpen = await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0 }),
      });
      assert.equal(dupOpen.status, 409);

      // vendita in contanti
      await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ product_id: product.id, qty: 1 }],
          payment_method: "cash",
        }),
      });
      // vendita con carta (non incide sui contanti attesi)
      await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ product_id: product.id, qty: 1 }],
          payment_method: "card",
        }),
      });

      const current = (await request({ url: "/api/sessions/current" })).json().session;
      assert.equal(current.totals.expectedCashCents, 10000 + product.price_cents);
      assert.equal(current.totals.salesCount, 2);

      // chiusura con ammanco di 100
      const counted = 10000 + product.price_cents - 100;
      const closeRes = await request({
        method: "POST",
        url: "/api/sessions/close",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ counted_cash_cents: counted }),
      });
      const closed = closeRes.json().session;
      assert.equal(closed.expected_cash_cents, 10000 + product.price_cents);
      assert.equal(closed.difference_cents, -100);
    });
  } finally {
    harness.cleanup();
  }
});

test("storno di una vendita specifica e export per-transazione", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const product = (await request({ url: "/api/products" })).json()[0];

      await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0, operator: "Luca" }),
      });

      await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ product_id: product.id, qty: 1 }] }),
      });

      // storia vendite
      const list = (await request({ url: "/api/sales?limit=10" })).json();
      assert.equal(list.length, 1);
      assert.equal(list[0].operator, "Luca");
      assert.ok(Array.isArray(list[0].items) && list[0].items.length === 1);
      const saleId = list[0].id;

      // storno con motivo
      const voidRes = await request({
        method: "POST",
        url: `/api/sales/${saleId}/void`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Errore cassiere" }),
      });
      assert.equal(voidRes.status, 200);

      const detail = (await request({ url: `/api/sales/${saleId}` })).json();
      assert.equal(detail.voided, 1);
      assert.equal(detail.void_reason, "Errore cassiere");

      // doppio storno -> 400
      const voidAgain = await request({ method: "POST", url: `/api/sales/${saleId}/void` });
      assert.equal(voidAgain.status, 400);

      // export per-transazione
      const pad2 = (n) => String(n).padStart(2, "0");
      const localYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const todayYmd = localYmd(new Date());
      const tomorrow = localYmd(new Date(Date.now() + 86400000));
      const csv = await request({
        url: `/api/reports/transactions.csv?from=${todayYmd}&to=${tomorrow}`,
      });
      assert.equal(csv.status, 200);
      assert.match(csv.text, /sale_number;datetime;operator/);
      assert.match(csv.text, /Luca/);
    });
  } finally {
    harness.cleanup();
  }
});

test("sconto percentuale e omaggio applicati correttamente", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const product = (await request({ url: "/api/products" })).json()[0];

      await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0 }),
      });

      // sconto 10% su 2 pezzi
      const disc = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ product_id: product.id, qty: 2 }],
          payment_method: "card",
          discount: { type: "percent", value: 10 },
        }),
      });
      assert.equal(disc.status, 200);
      const db1 = disc.json();
      assert.equal(db1.subtotal_cents, product.price_cents * 2);
      assert.equal(db1.discount_cents, Math.round(product.price_cents * 2 * 0.1));
      assert.equal(db1.total_cents, product.price_cents * 2 - db1.discount_cents);

      // omaggio: totale 0
      const gift = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ product_id: product.id, qty: 1 }],
          payment_method: "cash",
          discount: { type: "gift" },
        }),
      });
      assert.equal(gift.status, 200);
      assert.equal(gift.json().total_cents, 0);
      assert.equal(gift.json().discount_cents, product.price_cents);

      // percentuale fuori range -> 400
      const bad = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ product_id: product.id, qty: 1 }],
          discount: { type: "percent", value: 150 },
        }),
      });
      assert.equal(bad.status, 400);

      // il report del giorno riporta lo sconto totale erogato
      const today = (await request({ url: "/api/reports/today" })).json();
      assert.equal(today.summary.discount_cents, db1.discount_cents + product.price_cents);
    });
  } finally {
    harness.cleanup();
  }
});

test("errore stampa conserva la vendita e consente una ristampa esplicita", async () => {
  let printCalls = 0;
  let printerOffline = true;
  const harness = createHarness({
    printTicket: async () => {
      printCalls += 1;
      if (printerOffline) throw new Error("Stampante offline\ncon dettaglio");
    },
  });

  try {
    await harness.withServer(async ({ request }) => {
      const productsRes = await request({ url: "/api/products" });
      const product = productsRes.json()[0];

      await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0 }),
      });

      const saleBody = JSON.stringify({
        items: [{ product_id: product.id, qty: 1 }],
      });
      const saleHeaders = {
        "Content-Type": "application/json",
        "Idempotency-Key": "print-failure-preserved-0001",
      };
      const saleRes = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: saleHeaders,
        body: saleBody,
      });

      assert.equal(saleRes.status, 502);
      assert.equal(saleRes.json().sale_recorded, true);
      assert.equal(saleRes.json().print_status, "failed");
      assert.match(saleRes.json().error, /registrata/);
      assert.equal(printCalls, 1);

      const todayRes = await request({ url: "/api/reports/today" });
      const today = todayRes.json();
      assert.equal(today.summary.sales_count, 1);
      assert.equal(today.summary.revenue_cents, product.price_cents);

      const sale = (await request({ url: "/api/sales?limit=1" })).json()[0];
      assert.equal(sale.voided, 0);
      assert.equal(sale.print_status, "failed");
      assert.equal(sale.print_attempts, 1);
      assert.equal(sale.last_print_error, "Stampante offline con dettaglio");
      assert.equal(sale.can_reprint, true);

      // Un retry dell'incasso non crea vendite e non ristampa implicitamente.
      const retry = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: saleHeaders,
        body: saleBody,
      });
      assert.equal(retry.status, 409);
      assert.equal(retry.json().sale_recorded, true);
      assert.equal(retry.json().print_status, "failed");
      assert.equal(printCalls, 1);

      printerOffline = false;
      const reprint = await request({
        method: "POST",
        url: `/api/sales/${sale.id}/reprint`,
      });
      assert.equal(reprint.status, 200);
      assert.equal(reprint.json().print_status, "printed");
      assert.equal(reprint.json().print_attempts, 2);
      assert.equal(printCalls, 2);

      const printedSale = (await request({ url: `/api/sales/${sale.id}` })).json();
      assert.equal(printedSale.print_status, "printed");
      assert.equal(printedSale.last_print_error, null);
      assert.ok(printedSale.last_printed_at);

      assert.equal((await request({
        method: "POST",
        url: `/api/sales/${sale.id}/void`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Test ristampa annullata" }),
      })).status, 200);
      assert.equal((await request({
        method: "POST",
        url: `/api/sales/${sale.id}/reprint`,
      })).status, 409);
    });
  } finally {
    harness.cleanup();
  }
});

test("validazione rigorosa: rifiuta centesimi frazionari e carrelli parzialmente invalidi", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const product = (await request({ url: "/api/products" })).json()[0];

      const fractionalProduct = await request({
        method: "POST",
        url: "/api/products",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Prezzo frazionario", price_cents: 1.5 }),
      });
      assert.equal(fractionalProduct.status, 400);

      const fractionalFloat = await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 1.5 }),
      });
      assert.equal(fractionalFloat.status, 400);

      await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0 }),
      });

      const mixed = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            { product_id: product.id, qty: 1 },
            { product_id: product.id, qty: -1 },
          ],
        }),
      });
      assert.equal(mixed.status, 400);

      const duplicate = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            { product_id: product.id, qty: 1 },
            { product_id: product.id, qty: 1 },
          ],
        }),
      });
      assert.equal(duplicate.status, 400);

      const emptyInvalidPayment = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [], payment_method: "bitcoin" }),
      });
      assert.equal(emptyInvalidPayment.status, 400);
      assert.equal(emptyInvalidPayment.json().error, "Carrello vuoto");

      const sales = (await request({ url: "/api/sales" })).json();
      assert.equal(sales.length, 0);

      const badRange = await request({ url: "/api/reports/export.csv?from=non-data" });
      assert.equal(badRange.status, 400);
      assert.match(badRange.json().error, /YYYY-MM-DD/);
    });
  } finally {
    harness.cleanup();
  }
});

test("storico immutabile e storni vietati dopo la chiusura del turno", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const product = (await request({ url: "/api/products" })).json()[0];
      const originalName = product.name;

      await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0, operator: "Anna" }),
      });
      await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ product_id: product.id, qty: 1 }] }),
      });

      let sale = (await request({ url: "/api/sales?limit=1" })).json()[0];
      assert.equal(sale.items[0].name, originalName);
      assert.equal(sale.can_void, true);

      await request({
        method: "PATCH",
        url: `/api/products/${product.id}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Nome nuovo" }),
      });

      sale = (await request({ url: "/api/sales?limit=1" })).json()[0];
      assert.equal(sale.items[0].name, originalName);
      const report = (await request({ url: "/api/reports/today" })).json();
      assert.equal(report.byProduct[0].name, originalName);

      const close = await request({
        method: "POST",
        url: "/api/sessions/close",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ counted_cash_cents: product.price_cents }),
      });
      assert.equal(close.status, 200);

      const forbiddenVoid = await request({
        method: "POST",
        url: `/api/sales/${sale.id}/void`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Troppo tardi" }),
      });
      assert.equal(forbiddenVoid.status, 409);

      const closedSale = (await request({ url: "/api/sales?limit=1" })).json()[0];
      assert.equal(closedSale.can_void, false);
      assert.equal(closedSale.voided, 0);

      const session = (await request({ url: "/api/sessions/1" })).json().session;
      assert.equal(session.expected_cash_cents, session.totals.expectedCashCents);
      assert.equal(session.difference_cents, 0);
    });
  } finally {
    harness.cleanup();
  }
});

test("lo sconto percentuale decimale resta coerente tra calcolo, storico e stampa", async () => {
  const printed = [];
  const harness = createHarness({ printTicket: async payload => printed.push(payload) });

  try {
    await harness.withServer(async ({ request }) => {
      const product = (await request({ url: "/api/products" })).json()[0];
      await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0 }),
      });

      const result = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ product_id: product.id, qty: 1 }],
          payment_method: "card",
          discount: { type: "percent", value: 12.5 },
        }),
      });
      assert.equal(result.status, 200);
      assert.equal(result.json().discount_cents, Math.round(product.price_cents * 0.125));

      const sale = (await request({ url: "/api/sales?limit=1" })).json()[0];
      assert.equal(sale.discount_value, 12.5);
      assert.equal(printed[0].discountValue, 12.5);
    });
  } finally {
    harness.cleanup();
  }
});

test("movimenti di cassa: prelievi e versamenti entrano nei contanti attesi", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const product = (await request({ url: "/api/products" })).json()[0];

      const postMovement = (body) => request({
        method: "POST",
        url: "/api/sessions/movements",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      // senza turno aperto -> 409
      const noSession = await postMovement({ direction: "in", amount_cents: 100, reason: "Monete" });
      assert.equal(noSession.status, 409);

      await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 10000, operator: "Anna" }),
      });

      // input non validi -> 400
      assert.equal((await postMovement({ direction: "sideways", amount_cents: 100, reason: "x" })).status, 400);
      assert.equal((await postMovement({ direction: "in", amount_cents: 0, reason: "x" })).status, 400);
      assert.equal((await postMovement({ direction: "in", amount_cents: 1.5, reason: "x" })).status, 400);
      assert.equal((await postMovement({ direction: "in", amount_cents: 100 })).status, 400);
      assert.equal((await postMovement({ direction: "in", amount_cents: 100, reason: "   " })).status, 400);

      // vendita in contanti + versamento + prelievo
      await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ product_id: product.id, qty: 1 }] }),
      });

      const deposit = await postMovement({ direction: "in", amount_cents: 500, reason: "Aggiunta monete per resto" });
      assert.equal(deposit.status, 200);

      const withdrawal = await postMovement({ direction: "out", amount_cents: 2000, reason: "Prelievo di sicurezza" });
      assert.equal(withdrawal.status, 200);

      const expected = 10000 + product.price_cents + 500 - 2000;
      const current = (await request({ url: "/api/sessions/current" })).json().session;
      assert.equal(current.totals.expectedCashCents, expected);
      assert.equal(current.totals.movementsInCents, 500);
      assert.equal(current.totals.movementsOutCents, 2000);
      assert.equal(current.movements.length, 2);
      assert.equal(current.movements[1].direction, "out");
      assert.equal(current.movements[1].operator, "Anna");
      assert.equal(current.movements[1].reason, "Prelievo di sicurezza");

      // prelievo oltre i contanti attesi -> 409
      const tooMuch = await postMovement({ direction: "out", amount_cents: expected + 1, reason: "Troppo" });
      assert.equal(tooMuch.status, 409);

      // la chiusura usa l'atteso comprensivo dei movimenti
      const closeRes = await request({
        method: "POST",
        url: "/api/sessions/close",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ counted_cash_cents: expected }),
      });
      const closed = closeRes.json().session;
      assert.equal(closed.expected_cash_cents, expected);
      assert.equal(closed.difference_cents, 0);

      // a turno chiuso i movimenti non sono piu' ammessi
      const afterClose = await postMovement({ direction: "in", amount_cents: 100, reason: "Tardi" });
      assert.equal(afterClose.status, 409);
    });
  } finally {
    harness.cleanup();
  }
});

test("movimenti di cassa: il replay con la stessa chiave non duplica il saldo", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ request }) => {
      await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 1000, operator: "Ada" }),
      });
      const key = "movement-retry-test-0001";
      const body = JSON.stringify({ direction: "in", amount_cents: 123, reason: "Resto" });
      const send = (payload = body) => request({
        method: "POST",
        url: "/api/sessions/movements",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: payload,
      });

      assert.equal((await send()).status, 200);
      const replay = await send();
      assert.equal(replay.status, 200);
      assert.equal(replay.json().idempotent_replay, true);
      const current = (await request({ url: "/api/sessions/current" })).json().session;
      assert.equal(current.movements.length, 1);
      assert.equal(current.totals.movementsInCents, 123);

      const conflict = await send(JSON.stringify({ direction: "in", amount_cents: 124, reason: "Resto" }));
      assert.equal(conflict.status, 409);
      assert.match(conflict.json().error, /richiesta diversa/);
    });
  } finally {
    harness.cleanup();
  }
});

test("esaurito e scorte: vendita bloccata, decremento e ripristino su storno", async () => {
  let failPrint = false;
  const harness = createHarness({
    printTicket: async () => {
      if (failPrint) throw new Error("Stampante offline");
    },
  });

  try {
    await harness.withServer(async ({ request }) => {
      const seeded = (await request({ url: "/api/products" })).json()[0];

      const sellSeeded = () => request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ product_id: seeded.id, qty: 1 }] }),
      });
      const getProduct = async (id) =>
        (await request({ url: "/api/products/all" })).json().find((p) => p.id === id);

      await request({
        method: "POST",
        url: "/api/sessions/open",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening_float_cents: 0 }),
      });

      // scorte non valide -> 400
      const badStock = await request({
        method: "POST",
        url: "/api/products",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Scorte rotte", price_cents: 100, stock: 1.5 }),
      });
      assert.equal(badStock.status, 400);

      // prodotto con scorte tracciate
      const created = await request({
        method: "POST",
        url: "/api/products",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Torta a fette", price_cents: 300, stock: 2 }),
      });
      const tortaId = created.json().id;
      assert.equal((await getProduct(tortaId)).stock, 2);

      // vendita oltre le scorte -> 409
      const overSell = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ product_id: tortaId, qty: 3 }] }),
      });
      assert.equal(overSell.status, 409);
      assert.match(overSell.json().error, /Scorte insufficienti/);

      // vendita di tutte le scorte -> stock a 0, poi non piu' vendibile
      const sellAll = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ product_id: tortaId, qty: 2 }] }),
      });
      assert.equal(sellAll.status, 200);
      assert.equal((await getProduct(tortaId)).stock, 0);

      const soldOutByStock = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ product_id: tortaId, qty: 1 }] }),
      });
      assert.equal(soldOutByStock.status, 409);

      // lo storno ripristina le scorte
      const lastSale = (await request({ url: "/api/sales?limit=1" })).json()[0];
      await request({
        method: "POST",
        url: `/api/sales/${lastSale.id}/void`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Ordine sbagliato" }),
      });
      assert.equal((await getProduct(tortaId)).stock, 2);

      // esaurito manuale: blocca la vendita anche senza scorte tracciate
      const markSoldOut = await request({
        method: "PATCH",
        url: `/api/products/${seeded.id}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sold_out: 1 }),
      });
      assert.equal(markSoldOut.status, 200);

      const blocked = await sellSeeded();
      assert.equal(blocked.status, 409);
      assert.match(blocked.json().error, /esaurito/i);

      await request({
        method: "PATCH",
        url: `/api/products/${seeded.id}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sold_out: 0 }),
      });
      assert.equal((await sellSeeded()).status, 200);

      // stampa fallita: la vendita resta valida e le scorte restano decrementate
      failPrint = true;
      const printFail = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ product_id: tortaId, qty: 1 }] }),
      });
      assert.equal(printFail.status, 502);
      assert.equal(printFail.json().sale_recorded, true);
      assert.equal((await getProduct(tortaId)).stock, 1);
      failPrint = false;

      // stock null = non tracciate: vendite senza limite di quantita'
      const untrack = await request({
        method: "PATCH",
        url: `/api/products/${tortaId}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stock: null }),
      });
      assert.equal(untrack.status, 200);
      assert.equal((await getProduct(tortaId)).stock, null);
      const bigSale = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ product_id: tortaId, qty: 50 }] }),
      });
      assert.equal(bigSale.status, 200);
    });
  } finally {
    harness.cleanup();
  }
});

test("storno: ripristina solo le scorte decrementate al momento della vendita", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const post = (url, body) => request({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const product = (await request({ url: "/api/products" })).json()[0];
      assert.equal(product.stock, null);

      await post("/api/sessions/open", { opening_float_cents: 0 });
      const sale = await post("/api/sales/print", {
        items: [{ product_id: product.id, qty: 2 }],
      });
      assert.equal(sale.status, 200);

      // Attivare il tracciamento dopo la vendita non deve trasformare lo
      // storno in un incremento di scorte mai sottratte.
      await request({
        method: "PATCH",
        url: `/api/products/${product.id}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stock: 10 }),
      });
      const savedSale = (await request({ url: "/api/sales?limit=1" })).json()[0];
      assert.equal((await post(`/api/sales/${savedSale.id}/void`, { reason: "Test snapshot" })).status, 200);

      const updated = (await request({ url: "/api/products/all" })).json()
        .find(p => p.id === product.id);
      assert.equal(updated.stock, 10);
    });
  } finally {
    harness.cleanup();
  }
});

test("storno dopo prelievo: protegge i contanti attesi e consente la correzione", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const post = (url, body) => request({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const product = (await request({ url: "/api/products" })).json()[0];

      await post("/api/sessions/open", { opening_float_cents: 0 });
      await post("/api/sales/print", { items: [{ product_id: product.id, qty: 1 }] });
      const sale = (await request({ url: "/api/sales?limit=1" })).json()[0];
      await post("/api/sessions/movements", {
        direction: "out", amount_cents: product.price_cents, reason: "Prelievo completo",
      });

      const blocked = await post(`/api/sales/${sale.id}/void`, { reason: "Storno dopo prelievo" });
      assert.equal(blocked.status, 409);
      assert.match(blocked.json().error, /versamento/i);

      await post("/api/sessions/movements", {
        direction: "in", amount_cents: product.price_cents, reason: "Rientro per storno",
      });
      assert.equal((await post(`/api/sales/${sale.id}/void`, { reason: "Storno corretto" })).status, 200);

      const current = (await request({ url: "/api/sessions/current" })).json().session;
      assert.equal(current.totals.expectedCashCents, 0);
      assert.equal((await post("/api/sessions/close", { counted_cash_cents: 0 })).status, 200);
    });
  } finally {
    harness.cleanup();
  }
});

test("stampa pendente: blocca movimenti, chiusura e storni concorrenti", async () => {
  let notifyPrintStarted;
  let rejectPrint;
  const printStarted = new Promise(resolve => { notifyPrintStarted = resolve; });
  const printResult = new Promise((resolve, reject) => { rejectPrint = reject; });
  const harness = createHarness({
    printTicket: async () => {
      notifyPrintStarted();
      return printResult;
    },
  });

  try {
    await harness.withServer(async ({ request }) => {
      const post = (url, body) => request({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const product = (await request({ url: "/api/products" })).json()[0];
      await request({
        method: "PATCH",
        url: `/api/products/${product.id}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stock: 5 }),
      });
      await post("/api/sessions/open", { opening_float_cents: 0 });

      const saleRequest = post("/api/sales/print", { items: [{ product_id: product.id, qty: 1 }] });
      await printStarted;

      assert.equal((await post("/api/sessions/movements", {
        direction: "out", amount_cents: product.price_cents, reason: "Durante stampa",
      })).status, 409);
      assert.equal((await post("/api/sessions/close", { counted_cash_cents: 0 })).status, 409);
      assert.equal((await post("/api/sales/1/void", { reason: "Durante stampa" })).status, 409);
      assert.equal((await post("/api/sales/void-last", {})).status, 409);

      rejectPrint(new Error("Stampante offline"));
      assert.equal((await saleRequest).status, 502);

      const updated = (await request({ url: "/api/products/all" })).json()
        .find(p => p.id === product.id);
      assert.equal(updated.stock, 4);
      const current = (await request({ url: "/api/sessions/current" })).json();
      assert.equal(current.session.totals.expectedCashCents, product.price_cents);
      assert.equal((await post("/api/sessions/close", { counted_cash_cents: 0 })).status, 200);
    });
  } finally {
    harness.cleanup();
  }
});

test("coerenza prezzi: un cambio concorrente blocca la vendita prima di scrivere o scalare scorte", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const post = (url, body) => request({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const created = await post("/api/products", {
        name: "Prezzo concorrente",
        price_cents: 500,
        stock: 5,
      });
      const productId = created.json().id;
      await post("/api/sessions/open", { opening_float_cents: 0 });

      assert.equal((await request({
        method: "PATCH",
        url: `/api/products/${productId}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ price_cents: 650 }),
      })).status, 200);

      const stale = await post("/api/sales/print", {
        items: [{ product_id: productId, qty: 2, expected_unit_price_cents: 500 }],
        payment_method: "card",
      });
      assert.equal(stale.status, 409);
      assert.equal(stale.json().code, "PRICE_CHANGED");
      assert.equal(stale.json().current_price_cents, 650);

      const afterBlock = (await request({ url: "/api/products/all" })).json()
        .find(product => product.id === productId);
      assert.equal(afterBlock.stock, 5);
      assert.equal((await request({ url: "/api/sales?limit=10" })).json().length, 0);

      const current = await post("/api/sales/print", {
        items: [{ product_id: productId, qty: 2, expected_unit_price_cents: 650 }],
        payment_method: "card",
      });
      assert.equal(current.status, 200);
      assert.equal(current.json().total_cents, 1300);
      const afterSale = (await request({ url: "/api/products/all" })).json()
        .find(product => product.id === productId);
      assert.equal(afterSale.stock, 3);
    });
  } finally {
    harness.cleanup();
  }
});

test("comande sospese: persistono nel turno e proteggono chiusura ed eliminazione prodotto", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ request }) => {
      const post = (url, body) => request({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const created = await post("/api/products", {
        name: "Prodotto sospeso",
        price_cents: 800,
        stock: 3,
      });
      const productId = created.json().id;
      await post("/api/sessions/open", { opening_float_cents: 0, operator: "Ada" });

      const suspended = await post("/api/carts", {
        label: "Tavolo 7",
        items: [{ product_id: productId, qty: 2 }],
      });
      assert.equal(suspended.status, 201);
      assert.equal(suspended.json().cart.label, "Tavolo 7");
      assert.equal(suspended.json().cart.items[0].qty, 2);

      await request({
        method: "PATCH",
        url: `/api/products/${productId}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ price_cents: 900 }),
      });
      const list = await request({ url: "/api/carts" });
      assert.equal(list.status, 200);
      assert.equal(list.json().carts.length, 1);
      assert.equal(list.json().carts[0].items[0].price_cents, 900);

      const blockedDelete = await request({ method: "DELETE", url: `/api/products/${productId}` });
      assert.equal(blockedDelete.status, 409);
      assert.match(blockedDelete.json().error, /comanda sospesa/i);
      const blockedClose = await post("/api/sessions/close", { counted_cash_cents: 0 });
      assert.equal(blockedClose.status, 409);
      assert.match(blockedClose.json().error, /comand.*sospes/i);

      const cartId = list.json().carts[0].id;
      assert.equal((await request({ method: "DELETE", url: `/api/carts/${cartId}` })).status, 200);
      assert.equal((await request({ method: "DELETE", url: `/api/products/${productId}` })).status, 200);
      assert.equal((await post("/api/sessions/close", { counted_cash_cents: 0 })).status, 200);
    });
  } finally {
    harness.cleanup();
  }
});

test("comande sospese: creazione e ripresa sono idempotenti e la ripresa e' atomica", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ request }) => {
      const post = (url, body, key) => request({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
      });
      const productId = (await post("/api/products", {
        name: "Comanda idempotente", price_cents: 500, stock: 10,
      }, "unused-product-key")).json().id;
      await post("/api/sessions/open", { opening_float_cents: 0 }, "unused-session-key");

      const createKey = "suspend-cart-retry-0001";
      const payload = { label: "Tavolo 3", items: [{ product_id: productId, qty: 2 }] };
      const first = await post("/api/carts", payload, createKey);
      const replay = await post("/api/carts", payload, createKey);
      assert.equal(first.status, 201);
      assert.equal(replay.status, 200);
      assert.equal(replay.json().idempotent_replay, true);
      assert.equal((await request({ url: "/api/carts" })).json().carts.length, 1);

      const cartId = first.json().cart.id;
      const resumeKey = "resume-cart-retry-0001";
      const resumed = await post(`/api/carts/${cartId}/resume`, {}, resumeKey);
      const resumedReplay = await post(`/api/carts/${cartId}/resume`, {}, resumeKey);
      assert.equal(resumed.status, 200);
      assert.equal(resumedReplay.status, 200);
      assert.equal(resumedReplay.json().idempotent_replay, true);
      assert.equal(resumedReplay.json().cart.id, cartId);
      assert.equal((await request({ url: "/api/carts" })).json().carts.length, 0);

      const competing = await post(`/api/carts/${cartId}/resume`, {}, "resume-cart-competing-0002");
      assert.equal(competing.status, 404);
    });
  } finally {
    harness.cleanup();
  }
});

test("varianti, modificatori e note restano coerenti tra catalogo, comande, vendita e storico", async () => {
  const printed = [];
  const harness = createHarness({ printTicket: async payload => printed.push(payload) });

  try {
    await harness.withServer(async ({ request }) => {
      const post = (url, body) => request({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const patch = (url, body) => request({
        method: "PATCH",
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const created = await post("/api/products", {
        name: "Panino configurabile",
        price_cents: 500,
        stock: 5,
        option_groups: [
          {
            name: "Formato",
            selection_type: "single",
            required: 1,
            options: [
              { name: "Normale", price_delta_cents: 0 },
              { name: "Grande", price_delta_cents: 200 },
            ],
          },
          {
            name: "Extra",
            selection_type: "multiple",
            required: 0,
            options: [{ name: "Formaggio", price_delta_cents: 100 }],
          },
        ],
      });
      assert.equal(created.status, 200);
      const productId = created.json().id;

      const catalog = (await request({ url: "/api/products/all" })).json();
      const product = catalog.find(entry => entry.id === productId);
      const format = product.option_groups.find(group => group.name === "Formato");
      const extras = product.option_groups.find(group => group.name === "Extra");
      const normale = format.options.find(option => option.name === "Normale");
      const grande = format.options.find(option => option.name === "Grande");
      const formaggio = extras.options[0];

      const stableUpdate = await patch(`/api/products/${productId}`, {
        category: "Cucina",
        option_groups: product.option_groups,
      });
      assert.equal(stableUpdate.status, 200);
      const afterUpdate = (await request({ url: "/api/products/all" })).json()
        .find(entry => entry.id === productId);
      assert.deepEqual(
        afterUpdate.option_groups.map(group => [group.id, group.options.map(option => option.id)]),
        product.option_groups.map(group => [group.id, group.options.map(option => option.id)])
      );

      const swappedGroups = afterUpdate.option_groups.map(group => ({
        ...group,
        name: group.id === format.id ? "Extra" : "Formato",
        options: group.options.map(option => ({
          ...option,
          name: option.id === normale.id ? "Grande"
            : option.id === grande.id ? "Normale" : option.name,
        })),
      }));
      assert.equal((await patch(`/api/products/${productId}`, {
        option_groups: swappedGroups,
      })).status, 200);
      assert.equal((await patch(`/api/products/${productId}`, {
        option_groups: product.option_groups,
      })).status, 200);

      const invalidReparent = await patch(`/api/products/${productId}`, {
        option_groups: [{
          name: "Nuovo gruppo",
          selection_type: "single",
          required: 0,
          options: [{ ...normale }],
        }],
      });
      assert.equal(invalidReparent.status, 400);

      assert.equal((await post("/api/sessions/open", {
        opening_float_cents: 0,
        operator: "Ada",
      })).status, 200);

      const missingRequired = await post("/api/sales/print", {
        items: [{ product_id: productId, qty: 1, expected_unit_price_cents: 500 }],
        payment_method: "card",
      });
      assert.equal(missingRequired.status, 409);
      assert.match(missingRequired.json().error, /Formato/);

      const suspended = await post("/api/carts", {
        label: "Tavolo 4",
        note: "Portare insieme",
        items: [{
          product_id: productId,
          qty: 1,
          selected_option_value_ids: [grande.id],
          expected_unit_price_cents: 700,
          note: "Ben cotto",
        }],
      });
      assert.equal(suspended.status, 201);
      assert.equal(suspended.json().cart.note, "Portare insieme");
      assert.equal(suspended.json().cart.items[0].note, "Ben cotto");
      assert.equal(suspended.json().cart.items[0].expected_unit_price_cents, 700);
      assert.equal(suspended.json().cart.items[0].selected_options[0].name, "Grande");
      assert.equal(await request({
        method: "DELETE",
        url: `/api/carts/${suspended.json().cart.id}`,
      }).then(response => response.status), 200);

      const sale = await post("/api/sales/print", {
        payment_method: "card",
        note: "Tavolo 4",
        items: [
          {
            product_id: productId,
            qty: 2,
            selected_option_value_ids: [grande.id],
            expected_unit_price_cents: 700,
            note: "Ben cotto",
          },
          {
            product_id: productId,
            qty: 1,
            selected_option_value_ids: [normale.id, formaggio.id],
            expected_unit_price_cents: 600,
          },
        ],
      });
      assert.equal(sale.status, 200);
      assert.equal(sale.json().total_cents, 2000);
      assert.equal(printed.length, 1);
      assert.equal(printed[0].orderNote, "Tavolo 4");
      assert.equal(printed[0].items[0].note, "Ben cotto");
      assert.deepEqual(printed[0].items[0].options.map(option => option.name), ["Grande"]);

      const currentProduct = (await request({ url: "/api/products/all" })).json()
        .find(entry => entry.id === productId);
      assert.equal(currentProduct.stock, 2);

      const renamedGroups = currentProduct.option_groups.map(group => ({
        ...group,
        options: group.options.map(option => option.id === grande.id
          ? { ...option, name: "Maxi", price_delta_cents: 250 }
          : option),
      }));
      assert.equal((await patch(`/api/products/${productId}`, {
        option_groups: renamedGroups,
      })).status, 200);

      const history = (await request({ url: "/api/sales?limit=10" })).json();
      const savedSale = history.find(entry => entry.sale_number === sale.json().sale_number);
      assert.equal(savedSale.note, "Tavolo 4");
      assert.equal(savedSale.items[0].base_unit_price_cents, 500);
      assert.equal(savedSale.items[0].unit_price_cents, 700);
      assert.equal(savedSale.items[0].note, "Ben cotto");
      assert.deepEqual(savedSale.items[0].options.map(option => option.name), ["Grande"]);
    });
  } finally {
    harness.cleanup();
  }
});
