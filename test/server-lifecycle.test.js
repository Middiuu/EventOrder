const test = require("node:test");
const assert = require("node:assert/strict");

const { createShutdownController } = require("../src/server-lifecycle");

function silentLogger() {
  return { log() {}, error() {} };
}

test("shutdown chiude connessioni inattive e SQLite dopo le richieste attive", () => {
  let closeCallback;
  let idleClosed = false;
  let databaseClosed = false;
  let shuttingDown = false;
  const server = {
    close(callback) { closeCallback = callback; },
    closeIdleConnections() { idleClosed = true; },
  };
  const controller = createShutdownController({
    server,
    closeDatabase: () => { databaseClosed = true; },
    markShuttingDown: () => { shuttingDown = true; },
    timeoutMs: 1000,
    logger: silentLogger(),
  });

  assert.equal(controller.shutdown("SIGTERM"), true);
  assert.equal(controller.shutdown("SIGINT"), false);
  assert.equal(idleClosed, true);
  assert.equal(shuttingDown, true);
  assert.equal(databaseClosed, false);

  closeCallback();
  assert.equal(databaseClosed, true);
  assert.equal(process.exitCode, 0);
});

test("shutdown forza l'uscita se una richiesta non termina entro il limite", async () => {
  let allClosed = false;
  let databaseClosed = false;
  let exitCode;
  const server = {
    close() {},
    closeIdleConnections() {},
    closeAllConnections() { allClosed = true; },
  };
  const controller = createShutdownController({
    server,
    closeDatabase: () => { databaseClosed = true; },
    markShuttingDown() {},
    timeoutMs: 20,
    logger: silentLogger(),
    exit: code => { exitCode = code; },
  });

  controller.shutdown("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 35));

  assert.equal(allClosed, true);
  assert.equal(databaseClosed, true);
  assert.equal(exitCode, 1);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});

test("un errore SQLite rende non riuscito anche uno shutdown HTTP pulito", () => {
  let closeCallback;
  const server = {
    close(callback) { closeCallback = callback; },
    closeIdleConnections() {},
  };
  const controller = createShutdownController({
    server,
    closeDatabase: () => { throw new Error("SQLite close failed"); },
    markShuttingDown() {},
    timeoutMs: 1000,
    logger: silentLogger(),
  });

  controller.shutdown("SIGTERM");
  closeCallback();
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});
