const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("../package.json");
const { config } = require("./config");
const { db, DB_PATH, DB_SCHEMA_VERSION } = require("./db");
const { getMaintenanceState } = require("./maintenance");

let lifecycleState = "starting";

function markReady() {
  lifecycleState = "ready";
}

function markShuttingDown() {
  lifecycleState = "shutting_down";
}

function livenessStatus() {
  return {
    status: "ok",
    version: packageJson.version,
  };
}

function readinessStatus(options = {}) {
  const database = options.database || db;
  const databasePath = options.databasePath || DB_PATH;
  const maintenance = options.maintenance || getMaintenanceState();
  const state = options.lifecycleState || lifecycleState;
  const statfsSync = options.statfsSync || fs.statfsSync;
  const minimumFreeBytes = options.minimumFreeBytes
    ?? config.MIN_FREE_DISK_MB * 1024 * 1024;

  let databaseStatus = "ok";
  try {
    database.prepare("SELECT 1").get();
  } catch {
    databaseStatus = "unavailable";
  }

  let diskStatus = "ok";
  let freeBytes = null;
  try {
    const filesystem = statfsSync(path.dirname(databasePath));
    freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes < minimumFreeBytes) diskStatus = "low";
  } catch {
    diskStatus = "unavailable";
  }

  const ready = state === "ready"
    && databaseStatus === "ok"
    && diskStatus === "ok"
    && !maintenance.restoreInProgress;

  return {
    ready,
    body: {
      status: ready ? "ok" : "unavailable",
      version: packageJson.version,
      schema_version: DB_SCHEMA_VERSION,
      checks: {
        startup: state,
        database: databaseStatus,
        maintenance: maintenance.restoreInProgress
          ? "restore"
          : (maintenance.backupInProgress ? "backup" : "idle"),
        disk: diskStatus,
      },
      disk: {
        free_bytes: freeBytes,
        minimum_free_bytes: minimumFreeBytes,
      },
    },
  };
}

module.exports = {
  livenessStatus,
  markReady,
  markShuttingDown,
  readinessStatus,
};
