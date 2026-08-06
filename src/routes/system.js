const express = require("express");
const { livenessStatus, readinessStatus } = require("../operational-status");

const router = express.Router();

router.get("/health/live", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(livenessStatus());
});

router.get("/health/ready", (req, res) => {
  const readiness = readinessStatus();
  res.setHeader("Cache-Control", "no-store");
  res.status(readiness.ready ? 200 : 503).json(readiness.body);
});

// Alias compatibile per monitor esistenti: mantiene il payload minimo ma usa
// la semantica di readiness, non la sola vitalita' del processo.
router.get("/health", (req, res) => {
  const readiness = readinessStatus();
  res.setHeader("Cache-Control", "no-store");
  res.status(readiness.ready ? 200 : 503).json(readiness.ready ? {
    status: readiness.body.status,
    version: readiness.body.version,
    schema_version: readiness.body.schema_version,
  } : { status: "unavailable" });
});

module.exports = router;
