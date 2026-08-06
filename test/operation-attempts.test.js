const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadAttemptsApi() {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "operation-attempts.js"), "utf8");
  const context = vm.createContext({ Date, JSON, Math, Object, String, TypeError });
  vm.runInContext(source, context);
  return context.EventOrderAttempts;
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

test("i tentativi operativi conservano chiave, payload e contesto esatti", () => {
  const { createAttemptStore, keys } = loadAttemptsApi();
  const storage = memoryStorage();
  const store = createAttemptStore(storage);
  const context = { sessionId: 7, databaseInstanceId: 9 };

  store.save("checkout", { requestId: "request-123", payload: "{\"total\":500}" }, context);
  assert.equal(storage.has(keys.checkout), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(store.load("checkout", context))),
    {
      requestId: "request-123",
      payload: "{\"total\":500}",
      session_id: 7,
      database_instance_id: 9,
    }
  );
});

test("un tentativo malformato o appartenente a un altro database viene eliminato", () => {
  const { createAttemptStore, keys } = loadAttemptsApi();
  const storage = memoryStorage({
    [keys.movement]: JSON.stringify({ requestId: "request-456", session_id: 4, database_instance_id: 5 }),
  });
  const store = createAttemptStore(storage);

  assert.equal(store.load("movement", { sessionId: 4, databaseInstanceId: 6 }), null);
  assert.equal(storage.has(keys.movement), false);
  storage.setItem(keys.resume, "{non-json");
  assert.equal(store.load("resume", { sessionId: 4, databaseInstanceId: 6 }), null);
  assert.equal(storage.has(keys.resume), false);
});

test("la chiave usa randomUUID e conserva un fallback senza dipendenze", () => {
  const { newRequestId } = loadAttemptsApi();
  assert.equal(newRequestId({ randomUUID: () => "uuid-test" }), "uuid-test");
  assert.equal(newRequestId(null, () => 36, () => 0.5), "eo-10-i");
});
