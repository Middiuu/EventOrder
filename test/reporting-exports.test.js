const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { streamTransactionsCsv } = require("../src/reporting/exports");

function transaction(number) {
  return {
    sale_number: number,
    created_local: "2026-07-20 10:00:00",
    operator: "Ada",
    payment_method: "card",
    discount_cents: 0,
    total_cents: 500,
    voided: 0,
    session_id: 1,
    note: null,
  };
}

test("lo streaming CSV si interrompe senza terminare la risposta se il client si disconnette", async () => {
  let rowsRead = 0;
  const database = {
    prepare: () => ({
      *iterate() {
        rowsRead += 1;
        yield transaction(1);
        rowsRead += 1;
        yield transaction(2);
      },
    }),
  };
  const writes = [];
  const headers = new Map();
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.setHeader = (name, value) => headers.set(name, value);
  res.write = chunk => {
    writes.push(chunk);
    if (writes.length === 1) return true;
    queueMicrotask(() => {
      res.destroyed = true;
      res.emit("close");
    });
    return false;
  };
  let ended = false;
  res.end = () => { ended = true; };

  await streamTransactionsCsv(
    res,
    "transazioni.csv",
    database,
    { where: "1 = 1", params: [] }
  );

  assert.equal(headers.get("Content-Type"), "text/csv; charset=utf-8");
  assert.match(headers.get("Content-Disposition"), /transazioni\.csv/);
  assert.equal(writes.length, 2);
  assert.match(writes[0], /^\uFEFFsale_number;/);
  assert.match(writes[1], /^1;/);
  assert.equal(rowsRead, 1);
  assert.equal(ended, false);
  assert.equal(res.listenerCount("drain"), 0);
  assert.equal(res.listenerCount("close"), 0);
});

test("lo streaming CSV riprende dopo il drain e termina la risposta", async () => {
  const database = {
    prepare: () => ({ iterate: () => [transaction(1), transaction(2)] }),
  };
  const writes = [];
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.setHeader = () => {};
  res.write = chunk => {
    writes.push(chunk);
    if (writes.length !== 2) return true;
    queueMicrotask(() => res.emit("drain"));
    return false;
  };
  let ended = false;
  res.end = () => {
    ended = true;
    res.writableEnded = true;
  };

  await streamTransactionsCsv(
    res,
    "transazioni.csv",
    database,
    { where: "1 = 1", params: [] }
  );

  assert.equal(writes.length, 3);
  assert.match(writes[2], /^2;/);
  assert.equal(ended, true);
  assert.equal(res.listenerCount("drain"), 0);
  assert.equal(res.listenerCount("close"), 0);
});
