const express = require("express");
const path = require("path");
const { initDb } = require("./db");
const products = require("./routes/products");
const createSalesRouter = require("./routes/sales");
const reports = require("./routes/reports");
const sessions = require("./routes/sessions");
const printer = require("./printer");
const { publicConfig } = require("./config");
const { authMiddleware, loginHandler } = require("./auth");

function createApp(options = {}) {
  const printTicket = options.printTicket || printer.printTicket;

  initDb();

  const app = express();
  app.use(express.json());

  // Config pubblica per il frontend (branding, valuta, locale) — sempre accessibile
  app.get("/api/config", (req, res) => res.json(publicConfig()));
  // Login (attivo solo se APP_PIN e' impostato) — deve precedere il gate
  app.post("/api/auth/login", loginHandler);

  // Gate d'accesso opzionale con PIN (no-op se APP_PIN non e' impostato)
  app.use(authMiddleware);

  app.use("/api/products", products);
  app.use("/api/sales", createSalesRouter({ printTicket }));
  app.use("/api/sessions", sessions);
  app.use("/api/reports", reports);

  app.use("/vendor", express.static(path.join(__dirname, "..", "node_modules")));
  app.use(express.static(path.join(__dirname, "..", "public")));

  // Error handler globale: risposta JSON coerente invece della pagina di default
  app.use((err, req, res, next) => {
    console.error("Errore non gestito:", err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: "Errore interno del server" });
  });

  return app;
}

module.exports = { createApp };
