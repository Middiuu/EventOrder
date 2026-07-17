const test = require("node:test");
const assert = require("node:assert/strict");

test("il ticket interpreta i timestamp SQLite come UTC", () => {
  process.env.TZ = "Europe/Rome";
  const { buildTicketText } = require("../src/printer");
  const text = buildTicketText({
    saleNumber: 1,
    createdAt: "2026-07-13 12:00:00",
    items: [{ name: "Prodotto", qty: 1 }],
    subtotalCents: 500,
    discountCents: 0,
    totalCents: 500,
    paymentMethod: "card",
  });

  assert.match(text, /14:00:00/);
});

test("il ticket stampa opzioni e note di preparazione", () => {
  const { buildTicketText } = require("../src/printer");
  const text = buildTicketText({
    saleNumber: 2,
    createdAt: "2026-07-13 12:00:00",
    items: [{
      name: "Panino",
      qty: 1,
      note: "Senza cipolla",
      options: [
        { group_name: "Formato", name: "Grande", price_delta_cents: 200 },
        { group_name: "Extra", name: "Formaggio", price_delta_cents: 100 },
      ],
    }],
    subtotalCents: 800,
    discountCents: 0,
    totalCents: 800,
    paymentMethod: "cash",
    orderNote: "Tavolo esterno",
  });

  assert.match(text, /Formato: Grande/);
  assert.match(text, /Extra: Formaggio/);
  assert.match(text, /Nota: Senza cipolla/);
  assert.match(text, /NOTA: Tavolo esterno/);
});
