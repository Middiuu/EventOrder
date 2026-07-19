const express = require("express");
const packageJson = require("../../package.json");
const { db, DB_SCHEMA_VERSION } = require("../db");

const router = express.Router();

router.get("/health", (req, res) => {
  try {
    db.prepare("SELECT 1").get();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: "ok",
      version: packageJson.version,
      schema_version: DB_SCHEMA_VERSION,
    });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});

module.exports = router;
