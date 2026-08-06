const test = require("node:test");
const assert = require("node:assert/strict");

const {
  livenessStatus,
  readinessStatus,
} = require("../src/operational-status");

const healthyDatabase = {
  prepare() {
    return { get: () => ({ ok: 1 }) };
  },
};

test("liveness non dipende da database, manutenzione o spazio disco", () => {
  assert.deepEqual(livenessStatus(), {
    status: "ok",
    version: "1.0.0",
  });
});

test("readiness fallisce chiusa durante avvio, shutdown, restore e spazio basso", () => {
  const common = {
    database: healthyDatabase,
    databasePath: "/tmp/eventorder-readiness/pos.sqlite",
    statfsSync: () => ({ bavail: 1024, bsize: 1024 }),
    minimumFreeBytes: 512 * 1024,
    maintenance: { backupInProgress: false, restoreInProgress: false },
  };

  assert.equal(readinessStatus({ ...common, lifecycleState: "ready" }).ready, true);
  assert.equal(readinessStatus({ ...common, lifecycleState: "starting" }).ready, false);
  assert.equal(readinessStatus({ ...common, lifecycleState: "shutting_down" }).ready, false);
  assert.equal(readinessStatus({
    ...common,
    lifecycleState: "ready",
    maintenance: { backupInProgress: false, restoreInProgress: true },
  }).ready, false);
  const lowDisk = readinessStatus({
    ...common,
    lifecycleState: "ready",
    minimumFreeBytes: 2 * 1024 * 1024,
  });
  assert.equal(lowDisk.ready, false);
  assert.equal(lowDisk.body.checks.disk, "low");
});

test("readiness resta disponibile durante un backup online ma ne espone lo stato", () => {
  const result = readinessStatus({
    database: healthyDatabase,
    databasePath: "/tmp/eventorder-readiness/pos.sqlite",
    statfsSync: () => ({ bavail: 1024, bsize: 1024 }),
    minimumFreeBytes: 512 * 1024,
    lifecycleState: "ready",
    maintenance: { backupInProgress: true, restoreInProgress: false },
  });

  assert.equal(result.ready, true);
  assert.equal(result.body.checks.maintenance, "backup");
});

test("readiness non espone dettagli di errore del database", () => {
  const result = readinessStatus({
    database: { prepare: () => { throw new Error("secret-path/pos.sqlite"); } },
    databasePath: "/tmp/eventorder-readiness/pos.sqlite",
    statfsSync: () => ({ bavail: 1024, bsize: 1024 }),
    minimumFreeBytes: 1,
    lifecycleState: "ready",
    maintenance: { backupInProgress: false, restoreInProgress: false },
  });

  assert.equal(result.ready, false);
  assert.equal(result.body.checks.database, "unavailable");
  assert.doesNotMatch(JSON.stringify(result.body), /secret-path/);
});
