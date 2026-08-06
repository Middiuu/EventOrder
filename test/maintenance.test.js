const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  acquireRestoreLock,
  getMaintenanceState,
  releaseRestoreLock,
} = require("../src/maintenance");

test("la disconnessione HTTP non rilascia il lock mentre il restore continua", () => {
  const req = {};
  const res = new EventEmitter();
  let nextCalled = false;

  acquireRestoreLock(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(getMaintenanceState().restoreInProgress, true);

  res.emit("close");
  assert.equal(getMaintenanceState().restoreInProgress, true);

  releaseRestoreLock(req);
  assert.equal(getMaintenanceState().restoreInProgress, false);
});

test("il lock di restore viene rilasciato una sola volta a risposta conclusa", () => {
  const req = {};
  const res = new EventEmitter();

  acquireRestoreLock(req, res, () => {});
  res.emit("finish");
  releaseRestoreLock(req);

  assert.deepEqual(getMaintenanceState(), {
    backupInProgress: false,
    restoreInProgress: false,
  });
});
