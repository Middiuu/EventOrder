const test = require("node:test");
const assert = require("node:assert/strict");
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

      const backupRes = await request({ url: "/api/reports/backup" });
      assert.equal(backupRes.status, 200);
      assert.match(String(backupRes.headers["content-disposition"]), /-backup-\d{8}-/);
      assert.ok(backupRes.buffer.length > 0);

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
      assert.ok(typeof cfg.locale === "string" && cfg.locale.length > 0);
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

test("errore stampa annulla automaticamente la vendita", async () => {
  const harness = createHarness({
    printTicket: async () => {
      throw new Error("Stampante offline");
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

      const saleRes = await request({
        method: "POST",
        url: "/api/sales/print",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ product_id: product.id, qty: 1 }],
        }),
      });

      assert.equal(saleRes.status, 502);
      assert.match(saleRes.json().error, /annullata automaticamente/);

      const todayRes = await request({ url: "/api/reports/today" });
      const today = todayRes.json();
      assert.equal(today.summary.sales_count, 0);
      assert.equal(today.summary.revenue_cents, 0);
    });
  } finally {
    harness.cleanup();
  }
});
