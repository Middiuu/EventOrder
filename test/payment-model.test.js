const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPaymentApi() {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "payment-model.js"), "utf8");
  const context = vm.createContext({ JSON, Math, Number, Object, Set, String, TypeError });
  vm.runInContext(source, context);
  return context.EventOrderPayment;
}

function parseCents(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const number = Number(raw.replace(",", "."));
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) : null;
}

test("il modello pagamento calcola sconti e totali ai limiti in centesimi", () => {
  const model = loadPaymentApi().createPaymentModel(parseCents);
  const subtotals = [0, 1, 999, 1_000_000_000_000];
  const percentages = [0, 0.01, 12.5, 33.33, 100];

  model.setDiscount("percent");
  for (const subtotal of subtotals) {
    for (const percentage of percentages) {
      model.setDiscountValue(String(percentage));
      assert.equal(
        model.discountCents(subtotal),
        Math.round(subtotal * percentage / 100),
        `${subtotal} al ${percentage}%`
      );
    }
  }

  model.setDiscount("amount");
  model.setDiscountValue("12,34");
  assert.equal(model.discountCents(1000), 1000);
  assert.equal(model.payableTotal(1000), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(model.discountBody())), { type: "amount", value: 1234 });

  model.setDiscount("gift");
  assert.equal(model.payableTotal(987), 0);
  assert.throws(() => model.payableTotal(-1), /Subtotale non valido/);
});

test("contanti e tagli rapidi formano uno stato di conferma deterministico", () => {
  const model = loadPaymentApi().createPaymentModel(parseCents);
  assert.deepEqual([...model.quickCashValues(1450)], [1450, 1500, 2000, 5000, 10000]);

  model.setCashReceivedValue("14");
  assert.deepEqual(JSON.parse(JSON.stringify(model.cashState(1450))), {
    canConfirm: false,
    receivedCents: 1400,
    changeCents: null,
  });
  model.setCashReceivedValue("20");
  assert.equal(model.cashState(1450).changeCents, 550);

  model.setPaymentMethod("card");
  model.setCashReceivedValue("");
  assert.equal(model.cashState(1450).canConfirm, true);
  assert.equal(model.cashState(1450).receivedCents, null);
});

test("payload e recovery conservano il contratto esatto del checkout", () => {
  const { createPaymentModel } = loadPaymentApi();
  const model = createPaymentModel(parseCents);
  const item = {
    product: { id: 7 },
    qty: 2,
    unit_price_cents: 500,
    selected_option_value_ids: [11, 12],
    note: "senza sale",
  };

  model.setDiscount("percent");
  model.setDiscountValue("150");
  assert.match(model.buildAttempt({
    items: [item], note: "Tavolo 3", subtotalCents: 1000, requestId: "req-1",
  }).error, /0-100/);

  model.setDiscountValue("10");
  model.setCashReceivedValue("10");
  const built = model.buildAttempt({
    items: [item], note: " Tavolo 3 ", subtotalCents: 1000, requestId: "req-1",
  });
  assert.equal(built.totalCents, 900);
  assert.equal(built.attempt.requestId, "req-1");
  assert.deepEqual(JSON.parse(built.attempt.payload), {
    items: [{
      product_id: 7,
      qty: 2,
      expected_unit_price_cents: 500,
      selected_option_value_ids: [11, 12],
      note: "senza sale",
    }],
    note: "Tavolo 3",
    payment_method: "cash",
    discount: { type: "percent", value: 10 },
    cash_received_cents: 1000,
  });

  const recovered = createPaymentModel(parseCents);
  assert.equal(recovered.restoreAttempt(built.attempt.payload), true);
  assert.equal(recovered.paymentMethod, "cash");
  assert.equal(recovered.discountType, "percent");
  assert.equal(recovered.discountValue, "10");
  assert.equal(recovered.cashReceivedValue, "10.00");
  assert.equal(recovered.restoreAttempt("{non-json"), false);
});
