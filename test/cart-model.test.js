const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCartApi() {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "cart-model.js"), "utf8");
  const context = vm.createContext({ Map, Set, JSON, Number, String, Date, Object });
  vm.runInContext(source, context);
  return context.EventOrderCart;
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    has: key => values.has(key),
  };
}

function product(overrides = {}) {
  return {
    id: 1,
    name: "Panino",
    price_cents: 500,
    sold_out: 0,
    stock: 5,
    option_groups: [{
      id: 10,
      name: "Formato",
      required: 1,
      selection_type: "single",
      options: [
        { id: 100, name: "Normale", price_delta_cents: 0 },
        { id: 101, name: "Grande", price_delta_cents: 200 },
      ],
    }],
    ...overrides,
  };
}

test("il modello costruisce righe canoniche e calcola il totale", () => {
  const { createCartModel } = loadCartApi();
  const model = createCartModel(memoryStorage());
  const missing = model.buildItem(product(), 1);
  assert.match(missing.error, /Scegli un'opzione/);

  const built = model.buildItem(product(), 2, [101, 101], "  senza sale  ");
  assert.equal(built.item.unit_price_cents, 700);
  assert.deepEqual([...built.item.selected_option_value_ids], [101]);
  assert.equal(built.item.note, "senza sale");
  model.items.set(built.key, built.item);
  assert.equal(model.total(), 1400);
  assert.equal(model.quantityForProduct(1), 2);
});

test("persistenza e recovery rispettano istanza, turno e disponibilita'", () => {
  const { createCartModel } = loadCartApi();
  const storage = memoryStorage();
  const source = createCartModel(storage);
  const built = source.buildItem(product(), 4, [100]);
  source.items.set(built.key, built.item);
  source.persist({ sessionId: 7, databaseInstanceId: 9, note: "non ancora" });
  assert.equal(storage.has("eventorder-current-cart-v1"), false);

  source.enablePersistence();
  source.persist({ sessionId: 7, databaseInstanceId: 9, note: " tavolo 2 " });
  const recovered = createCartModel(storage);
  const result = recovered.recover({
    products: [product({ stock: 3 })],
    sessionId: 7,
    databaseInstanceId: 9,
  });
  assert.equal(result.recovered, true);
  assert.deepEqual([...result.skipped], ["Panino"]);
  assert.equal(result.note, "tavolo 2");
  assert.equal(recovered.total(), 1500);

  const wrongInstance = createCartModel(storage);
  assert.equal(wrongInstance.recover({
    products: [product()], sessionId: 7, databaseInstanceId: 10,
  }).recovered, false);
  assert.equal(storage.has("eventorder-current-cart-v1"), false);
});

test("la riconciliazione aggiorna prezzi e segnala prodotti rimossi o insufficienti", () => {
  const { createCartModel } = loadCartApi();
  const model = createCartModel(memoryStorage());
  const first = model.buildItem(product(), 3, [100]);
  const removedProduct = product({ id: 2, name: "Rimosso", option_groups: [] });
  const second = model.buildItem(removedProduct, 1);
  model.items.set(first.key, first.item);
  model.items.set(second.key, second.item);

  const result = model.reconcile([product({ price_cents: 600, stock: 2 })]);
  assert.equal(result.oldTotal, 2000);
  assert.equal(result.newTotal, 1800);
  assert.deepEqual([...result.removed], ["Rimosso"]);
  assert.deepEqual([...result.unavailable], ["Panino"]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.priceChanges)),
    [{ name: "Panino", from: 500, to: 600 }]
  );
});
