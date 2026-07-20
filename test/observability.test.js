const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");

const configPath = path.join(__dirname, "..", "src", "config.js");
const observabilityPath = path.join(__dirname, "..", "src", "observability.js");

test("LOG_REQUESTS emette un record JSON completo alla fine della risposta", (t) => {
  const previousLogRequests = process.env.LOG_REQUESTS;
  process.env.LOG_REQUESTS = "1";
  delete require.cache[configPath];
  delete require.cache[observabilityPath];
  const { requestIdMiddleware } = require(observabilityPath);

  const output = [];
  const originalLog = console.log;
  console.log = line => output.push(line);
  t.after(() => {
    console.log = originalLog;
    if (previousLogRequests === undefined) delete process.env.LOG_REQUESTS;
    else process.env.LOG_REQUESTS = previousLogRequests;
    delete require.cache[configPath];
    delete require.cache[observabilityPath];
  });

  const req = {
    method: "POST",
    path: "/api/sessions/open",
    get: name => name === "X-Request-ID" ? "request-test-123" : undefined,
  };
  const res = new EventEmitter();
  res.statusCode = 201;
  res.setHeader = (name, value) => {
    assert.equal(name, "X-Request-ID");
    assert.equal(value, "request-test-123");
  };

  let nextCalled = false;
  requestIdMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(output.length, 0);

  res.emit("finish");
  assert.equal(output.length, 1);
  const record = JSON.parse(output[0]);
  assert.equal(record.level, "info");
  assert.equal(record.event, "http_request");
  assert.equal(record.request_id, "request-test-123");
  assert.equal(record.method, "POST");
  assert.equal(record.path, "/api/sessions/open");
  assert.equal(record.status, 201);
  assert.ok(Number.isFinite(record.duration_ms));
  assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});
