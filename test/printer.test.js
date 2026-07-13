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
