const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("./helpers/app-test-utils");

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
      const lines = itemsCsv.text.replace(/^﻿/, "").trim().split("\n");
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
