const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("./helpers/app-test-utils");
const { allocateNetByItem } = require("../src/reporting/service");
const reportQueries = require("../src/reporting/queries");

const pad2 = (n) => String(n).padStart(2, "0");
const localYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const TODAY = localYmd(new Date());
const TOMORROW = localYmd(new Date(Date.now() + 86400000));
const AFTER_TOMORROW = localYmd(new Date(Date.now() + 2 * 86400000));

function postJson(request, url, body) {
  return request({
    method: "POST",
    url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("la ripartizione sconto usa aritmetica intera anche oltre la precisione dei prodotti Number", () => {
  const items = [
    { id: 1, line_total_cents: 500_000_000_001 },
    { id: 2, line_total_cents: 499_999_999_999 },
  ];
  const allocation = allocateNetByItem({
    total_cents: 999_999_999_999,
    discount_cents: 1,
  }, items);

  assert.equal(allocation.get(1), 500_000_000_000);
  assert.equal(allocation.get(2), 499_999_999_999);
  assert.equal([...allocation.values()].reduce((sum, value) => sum + value, 0), 999_999_999_999);
});

test("summary: sconto ripartito sui prodotti al centesimo e filtro per data", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const p1 = (await postJson(request, "/api/products", { name: "Crostino", price_cents: 333 })).json().id;
      const p2 = (await postJson(request, "/api/products", { name: "Lasagna", price_cents: 500 })).json().id;

      await postJson(request, "/api/sessions/open", { opening_float_cents: 0 });

      // subtotale 1333, sconto 10% = 133, totale 1200
      const sale = await postJson(request, "/api/sales/print", {
        items: [{ product_id: p1, qty: 1 }, { product_id: p2, qty: 2 }],
        payment_method: "card",
        discount: { type: "percent", value: 10 },
      });
      assert.equal(sale.status, 200);
      assert.equal(sale.json().total_cents, 1200);

      const data = (await request({ url: "/api/reports/summary" })).json();
      assert.equal(data.summary.sales_count, 1);
      assert.equal(data.summary.revenue_cents, 1200);
      assert.equal(data.fromDay, TODAY);

      const crostino = data.byProduct.find((p) => p.name === "Crostino");
      const lasagna = data.byProduct.find((p) => p.name === "Lasagna");
      assert.equal(crostino.gross_revenue_cents, 333);
      assert.equal(lasagna.gross_revenue_cents, 1000);
      // il netto ripartito somma esattamente al totale incassato
      assert.equal(crostino.net_revenue_cents + lasagna.net_revenue_cents, 1200);
      assert.ok(crostino.net_revenue_cents < crostino.gross_revenue_cents);
      assert.ok(lasagna.net_revenue_cents < lasagna.gross_revenue_cents);

      // confronto giornate: la vendita cade nel giorno locale odierno
      assert.equal(data.byDay.length, 1);
      assert.equal(data.byDay[0].day, TODAY);
      assert.equal(data.byDay[0].revenue_cents, 1200);

      // intervallo senza vendite -> vuoto
      const empty = (await request({
        url: `/api/reports/summary?from=${TOMORROW}&to=${AFTER_TOMORROW}`,
      })).json();
      assert.equal(empty.summary.sales_count, 0);
      assert.equal(empty.byProduct.length, 0);

      // date non valide -> 400
      assert.equal((await request({ url: "/api/reports/summary?from=2026-02-31" })).status, 400);
      assert.equal((await request({ url: `/api/reports/summary?from=${TOMORROW}&to=${TOMORROW}` })).status, 400);
    });
  } finally {
    harness.cleanup();
  }
});

test("summary non fonde prodotti distinti con lo stesso nome storico", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const firstId = (await postJson(request, "/api/products", {
        name: "Nome riutilizzato",
        price_cents: 500,
      })).json().id;
      await postJson(request, "/api/sessions/open", { opening_float_cents: 0 });
      await postJson(request, "/api/sales/print", {
        items: [{ product_id: firstId, qty: 1 }],
      });
      const renamed = await request({
        method: "PATCH",
        url: `/api/products/${firstId}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Primo prodotto rinominato" }),
      });
      assert.equal(renamed.status, 200);

      const secondId = (await postJson(request, "/api/products", {
        name: "Nome riutilizzato",
        price_cents: 700,
      })).json().id;
      await postJson(request, "/api/sales/print", {
        items: [{ product_id: secondId, qty: 1 }],
      });

      const data = (await request({ url: "/api/reports/summary" })).json();
      const reusedName = data.byProduct.filter(product => product.name === "Nome riutilizzato");
      assert.equal(reusedName.length, 2);
      assert.deepEqual(
        reusedName.map(product => product.product_id).sort((a, b) => a - b),
        [firstId, secondId]
      );
      assert.deepEqual(
        reusedName.map(product => product.gross_revenue_cents).sort((a, b) => a - b),
        [500, 700]
      );
    });
  } finally {
    harness.cleanup();
  }
});

test("summary aggrega 100.000 vendite senza materializzarle in memoria", async () => {
  const harness = createHarness();

  try {
    await harness.withServer(async ({ request }) => {
      const product = (await request({ url: "/api/products" })).json()[0];
      const session = (await postJson(request, "/api/sessions/open", {
        opening_float_cents: 0,
      })).json().session;
      const { db } = require("../src/db");
      const insertSale = db.prepare(`
        INSERT INTO sales (sale_number, total_cents, payment_method, session_id, print_status)
        VALUES (?, 100, 'card', ?, 'printed')
      `);
      const insertItem = db.prepare(`
        INSERT INTO sale_items
          (sale_id, product_id, qty, unit_price_cents, base_unit_price_cents,
           line_total_cents, product_name, product_category)
        VALUES (?, ?, 1, 100, 100, 100, ?, ?)
      `);
      db.transaction(() => {
        for (let number = 1; number <= 100000; number += 1) {
          const sale = insertSale.run(number, session.id);
          insertItem.run(Number(sale.lastInsertRowid), product.id, product.name, product.category);
        }
      })();

      const response = await request({ url: `/api/reports/summary?session=${session.id}` });
      assert.equal(response.status, 200);
      assert.equal(response.json().summary.sales_count, 100000);
      assert.equal(response.json().summary.revenue_cents, 10000000);
      assert.equal(response.json().byProduct[0].qty_sold, 100000);
    });
  } finally {
    harness.cleanup();
  }
});

test("query plan report usa gli indici di data e turno senza sort temporanei", () => {
  const harness = createHarness();
  try {
    const { db } = require("../src/db");
    const explain = (statement, params) => db.prepare(`EXPLAIN QUERY PLAN ${statement.source}`)
      .all(...params)
      .map(row => row.detail)
      .join(" | ");
    const dateScope = {
      where: "s.created_at >= ? AND s.created_at < ?",
      params: ["2026-01-01 00:00:00", "2027-01-01 00:00:00"],
    };
    const sessionScope = { where: "s.session_id = ?", params: [1], sessionId: 1 };

    const dateSales = explain(reportQueries.iterateScopedSales(db, dateScope), dateScope.params);
    const dateItems = explain(
      reportQueries.iterateScopedItems(db, dateScope, { includeVoided: false }),
      dateScope.params
    );
    const sessionSales = explain(
      reportQueries.iterateScopedSales(db, sessionScope),
      sessionScope.params
    );
    const sessionItems = explain(
      reportQueries.iterateScopedItems(db, sessionScope, { includeVoided: false }),
      sessionScope.params
    );

    assert.match(dateSales, /idx_sales_voided/);
    assert.match(dateItems, /idx_sales_voided/);
    assert.match(dateItems, /idx_sale_items_sale_id/);
    assert.match(sessionSales, /idx_sales_session/);
    assert.match(sessionItems, /idx_sales_session/);
    assert.match(sessionItems, /idx_sale_items_sale_id/);
    assert.doesNotMatch(`${dateSales} ${dateItems} ${sessionSales} ${sessionItems}`, /TEMP B-TREE/);
  } finally {
    harness.cleanup();
  }
});

test("summary per turno e margine dal costo storicizzato", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const pid = (await postJson(request, "/api/products", {
        name: "Arrosticino", price_cents: 300, cost_cents: 100,
      })).json().id;

      // turno 1: vendita da 2 pezzi, poi chiusura
      await postJson(request, "/api/sessions/open", { opening_float_cents: 0 });
      await postJson(request, "/api/sales/print", { items: [{ product_id: pid, qty: 2 }] });
      await postJson(request, "/api/sessions/close", { counted_cash_cents: 600 });

      // turno 2: vendita da 1 pezzo
      await postJson(request, "/api/sessions/open", { opening_float_cents: 0 });
      await postJson(request, "/api/sales/print", { items: [{ product_id: pid, qty: 1 }] });

      const t1 = (await request({ url: "/api/reports/summary?session=1" })).json();
      assert.equal(t1.summary.sales_count, 1);
      assert.equal(t1.summary.revenue_cents, 600);
      assert.equal(t1.session, 1);
      // margine turno 1: 600 - 2*100 = 400
      assert.equal(t1.summary.margin_cents, 400);
      assert.equal(t1.summary.margin_complete, true);
      assert.equal(t1.summary.margin_coverage_percent, 100);
      assert.equal(t1.byProduct[0].margin_cents, 400);

      const t2 = (await request({ url: "/api/reports/summary?session=2" })).json();
      assert.equal(t2.summary.revenue_cents, 300);

      // il costo e' fotografato alla vendita: cambiarlo non altera lo storico
      await request({
        method: "PATCH",
        url: `/api/products/${pid}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cost_cents: 999 }),
      });
      const after = (await request({ url: "/api/reports/summary?session=1" })).json();
      assert.equal(after.summary.margin_cents, 400);

      // turno inesistente e' valido ma vuoto; id non valido -> 400
      assert.equal((await request({ url: "/api/reports/summary?session=abc" })).status, 400);
    });
  } finally {
    harness.cleanup();
  }
});

test("margine: conserva la quota nota e segnala copertura parziale", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const pid = (await postJson(request, "/api/products", {
        name: "Polenta", price_cents: 300,
      })).json().id;

      await postJson(request, "/api/sessions/open", { opening_float_cents: 0 });
      await postJson(request, "/api/sales/print", { items: [{ product_id: pid, qty: 1 }] });
      await request({
        method: "PATCH",
        url: `/api/products/${pid}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cost_cents: 100 }),
      });
      await postJson(request, "/api/sales/print", { items: [{ product_id: pid, qty: 1 }] });

      const data = (await request({ url: "/api/reports/summary" })).json();
      assert.equal(data.summary.revenue_cents, 600);
      assert.equal(data.summary.margin_cents, 200);
      assert.equal(data.summary.margin_complete, false);
      assert.equal(data.summary.margin_coverage_percent, 50);
      assert.equal(data.byProduct[0].margin_cents, 200);
      assert.equal(data.byProduct[0].margin_complete, false);
      assert.equal(data.byProduct[0].tracked_net_revenue_cents, 300);
    });
  } finally {
    harness.cleanup();
  }
});

test("elenco turni: chiusure con attesi, contati e differenza", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const product = (await request({ url: "/api/products" })).json()[0];

      await postJson(request, "/api/sessions/open", { opening_float_cents: 5000, operator: "Anna" });
      await postJson(request, "/api/sales/print", { items: [{ product_id: product.id, qty: 1 }] });
      await postJson(request, "/api/sessions/movements", {
        direction: "in", amount_cents: 200, reason: "Fondo aggiuntivo",
      });
      // chiusura con ammanco di 100
      await postJson(request, "/api/sessions/close", {
        counted_cash_cents: 5000 + product.price_cents + 200 - 100,
        note: "Mancano spicci",
      });

      await postJson(request, "/api/sessions/open", { opening_float_cents: 0, operator: "Luca" });

      const list = (await request({ url: "/api/sessions" })).json().sessions;
      assert.equal(list.length, 2);
      // piu' recenti prima: il turno aperto di Luca
      assert.equal(list[0].operator, "Luca");
      assert.equal(list[0].closed_at, null);

      const closed = list[1];
      assert.equal(closed.operator, "Anna");
      assert.equal(closed.expected_cash_cents, 5000 + product.price_cents + 200);
      assert.equal(closed.difference_cents, -100);
      assert.equal(closed.note, "Mancano spicci");
      assert.equal(closed.totals.revenueCents, product.price_cents);
      assert.equal(closed.totals.movementsInCents, 200);
      assert.equal(closed.movements.length, 1);
      assert.equal(closed.movements[0].reason, "Fondo aggiuntivo");

      assert.equal((await request({ url: "/api/sessions?limit=0" })).status, 400);
    });
  } finally {
    harness.cleanup();
  }
});

test("storico vendite filtrabile per numero, data, prodotto, operatore, metodo e stato", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const products = (await request({ url: "/api/products" })).json();
      const [pA, pB] = products;

      await postJson(request, "/api/sessions/open", { opening_float_cents: 0, operator: "Anna" });
      await postJson(request, "/api/sales/print", { items: [{ product_id: pA.id, qty: 1 }] });
      await postJson(request, "/api/sales/print", {
        items: [{ product_id: pB.id, qty: 1 }],
        payment_method: "card",
      });
      await postJson(request, "/api/sessions/close", { counted_cash_cents: pA.price_cents });

      await postJson(request, "/api/sessions/open", { opening_float_cents: 0, operator: "Luca" });
      await postJson(request, "/api/sales/print", { items: [{ product_id: pA.id, qty: 2 }] });
      await postJson(request, "/api/sales/void-last", {});

      const query = async (qs) => (await request({ url: `/api/sales?${qs}` })).json();

      assert.equal((await query("number=1")).length, 1);
      assert.equal((await query("number=1"))[0].sale_number, 1);
      assert.equal((await query("operator=Anna")).length, 2);
      assert.equal((await query("operator=Luca")).length, 1);
      assert.equal((await query("method=card")).length, 1);
      assert.equal((await query("status=voided")).length, 1);
      assert.equal((await query("status=valid")).length, 2);
      assert.equal((await query(`product=${encodeURIComponent(pB.name)}`)).length, 1);
      assert.equal((await query(`from=${TODAY}&to=${TODAY}`)).length, 3);
      assert.equal((await query(`from=${TOMORROW}`)).length, 0);
      // combinazione di filtri
      assert.equal((await query("operator=Anna&method=cash")).length, 1);

      assert.equal((await request({ url: "/api/sales?method=bitcoin" })).status, 400);
      assert.equal((await request({ url: "/api/sales?status=boh" })).status, 400);
      assert.equal((await request({ url: "/api/sales?from=2026-13-01" })).status, 400);
      assert.equal((await request({ url: "/api/sales?number=-1" })).status, 400);
    });
  } finally {
    harness.cleanup();
  }
});

test("storico vendite paginato con cursore senza rompere la risposta legacy", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const [product] = (await request({ url: "/api/products" })).json();
      await postJson(request, "/api/sessions/open", { opening_float_cents: 0, operator: "Ada" });
      for (let index = 0; index < 5; index += 1) {
        await postJson(request, "/api/sales/print", {
          items: [{ product_id: product.id, qty: 1 }],
        });
      }

      const legacy = (await request({ url: "/api/sales?limit=2" })).json();
      assert.ok(Array.isArray(legacy));
      assert.equal(legacy.length, 2);

      const first = (await request({ url: "/api/sales?paginated=1&limit=2" })).json();
      assert.deepEqual(first.sales.map(sale => sale.id), legacy.map(sale => sale.id));
      assert.equal(first.next_cursor, first.sales.at(-1).id);

      const second = (await request({
        url: `/api/sales?paginated=1&limit=2&cursor=${first.next_cursor}`,
      })).json();
      assert.equal(second.sales.length, 2);
      assert.equal(second.next_cursor, second.sales.at(-1).id);
      assert.equal(first.sales.some(sale => second.sales.some(next => next.id === sale.id)), false);

      const last = (await request({
        url: `/api/sales?paginated=1&limit=2&cursor=${second.next_cursor}`,
      })).json();
      assert.equal(last.sales.length, 1);
      assert.equal(last.next_cursor, null);

      assert.equal((await request({ url: "/api/sales?paginated=1&cursor=0" })).status, 400);
      assert.equal((await request({ url: "/api/sales?paginated=1&cursor=abc" })).status, 400);
    });
  } finally {
    harness.cleanup();
  }
});

test("i caratteri wildcard nei filtri storico sono cercati letteralmente", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const percentProduct = (await postJson(request, "/api/products", {
        name: "Promo 100%", price_cents: 500,
      })).json().id;
      const plainProduct = (await postJson(request, "/api/products", {
        name: "Promo 100X", price_cents: 500,
      })).json().id;

      await postJson(request, "/api/sessions/open", { opening_float_cents: 0, operator: "Ada_1" });
      await postJson(request, "/api/sales/print", {
        items: [{ product_id: percentProduct, qty: 1 }], payment_method: "card",
      });
      await postJson(request, "/api/sessions/close", { counted_cash_cents: 0 });

      await postJson(request, "/api/sessions/open", { opening_float_cents: 0, operator: "AdaX1" });
      await postJson(request, "/api/sales/print", {
        items: [{ product_id: plainProduct, qty: 1 }], payment_method: "card",
      });

      const byProduct = (await request({
        url: `/api/sales?product=${encodeURIComponent("Promo 100%")}`,
      })).json();
      const byOperator = (await request({
        url: `/api/sales?operator=${encodeURIComponent("Ada_1")}`,
      })).json();

      assert.equal(byProduct.length, 1);
      assert.equal(byProduct[0].items[0].name, "Promo 100%");
      assert.equal(byOperator.length, 1);
      assert.equal(byOperator[0].operator, "Ada_1");
    });
  } finally {
    harness.cleanup();
  }
});

test("export: items.csv riga-per-articolo con sconto ripartito, aggregato con netto", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const p1 = (await postJson(request, "/api/products", {
        name: "Frittella", price_cents: 400, cost_cents: 150,
      })).json().id;
      const p2 = (await postJson(request, "/api/products", { name: "Vino", price_cents: 600 })).json().id;

      await postJson(request, "/api/sessions/open", { opening_float_cents: 0, operator: "Anna" });
      // subtotale 1400, sconto 200 -> totale 1200
      await postJson(request, "/api/sales/print", {
        items: [{ product_id: p1, qty: 2 }, { product_id: p2, qty: 1 }],
        payment_method: "cash",
        discount: { type: "amount", value: 200 },
      });

      const itemsCsv = await request({ url: `/api/reports/items.csv?from=${TODAY}&to=${TOMORROW}` });
      assert.equal(itemsCsv.status, 200);
      assert.equal(itemsCsv.headers["content-length"], undefined);
      assert.equal(itemsCsv.headers["transfer-encoding"], "chunked");
      const lines = itemsCsv.text.replace(/^\uFEFF/, "").trim().split("\n");
      assert.match(lines[0], /sale_number;datetime;operator;session_id;payment_method;voided;product_name/);
      assert.equal(lines.length, 3); // intestazione + 2 righe articolo

      const frittella = lines.find((l) => l.includes("Frittella"));
      const vino = lines.find((l) => l.includes("Vino"));
      // lordo 800, sconto ripartito 114, netto 686; costo 2*150=300
      // (gli importi con virgola decimale vengono quotati dal csvEscape)
      assert.match(frittella, /;2;"4,00";"8,00";"1,14";"6,86";"3,00"$/);
      // lordo 600, sconto 86, netto 514; costo non tracciato -> vuoto
      assert.match(vino, /;1;"6,00";"6,00";"0,86";"5,14";$/);

      const aggCsv = await request({ url: `/api/reports/export.csv?from=${TODAY}&to=${TOMORROW}` });
      assert.equal(aggCsv.status, 200);
      assert.match(aggCsv.text, /product_net_revenue_eur;product_margin_eur;product_margin_complete/);
      assert.match(aggCsv.text, /Frittella;2;"8,00";"6,86";"3,86"/); // margine 686-300
      assert.match(aggCsv.text, /Vino;1;"6,00";"5,14";/);

      // anche l'export per turno funziona
      const bySession = await request({ url: "/api/reports/items.csv?session=1" });
      assert.equal(bySession.status, 200);
      assert.match(String(bySession.headers["content-disposition"]), /turno-1/);
    });
  } finally {
    harness.cleanup();
  }
});

test("gli export CSV neutralizzano i prefissi interpretabili come formule", async () => {
  const harness = createHarness({ printTicket: async () => {} });

  try {
    await harness.withServer(async ({ request }) => {
      const productId = (await postJson(request, "/api/products", {
        name: "=2+3",
        category: "+Categoria",
        price_cents: 500,
      })).json().id;
      await postJson(request, "/api/sessions/open", {
        opening_float_cents: 0,
        operator: "@Operatore",
      });
      await postJson(request, "/api/sales/print", {
        items: [{ product_id: productId, qty: 1, note: "-Voce" }],
        note: "@Ordine",
        payment_method: "card",
      });

      const items = await request({
        url: `/api/reports/items.csv?from=${TODAY}&to=${TOMORROW}`,
      });
      assert.equal(items.status, 200);
      assert.match(items.text, /'@Operatore/);
      assert.match(items.text, /'=2\+3/);
      assert.match(items.text, /'\+Categoria/);
      assert.match(items.text, /'-Voce/);
      assert.match(items.text, /'@Ordine/);
      assert.doesNotMatch(items.text, /(?:^|;)[=+\-@]/m);

      const transactions = await request({
        url: `/api/reports/transactions.csv?from=${TODAY}&to=${TOMORROW}`,
      });
      assert.equal(transactions.headers["content-length"], undefined);
      assert.equal(transactions.headers["transfer-encoding"], "chunked");
      assert.match(transactions.text, /'@Operatore/);
      assert.match(transactions.text, /'@Ordine/);
    });
  } finally {
    harness.cleanup();
  }
});
