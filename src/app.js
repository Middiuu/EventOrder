const express = require("express");
const path = require("path");
const { initDb } = require("./db");
const products = require("./routes/products");
const createSalesRouter = require("./routes/sales");
const reports = require("./routes/reports");
const sessions = require("./routes/sessions");
const printer = require("./printer");
const { publicConfig } = require("./config");
const { authMiddleware, isAuthenticated, loginHandler, logoutHandler } = require("./auth");
const { maintenanceMiddleware } = require("./maintenance");

function createApp(options = {}) {
  const printTicket = options.printTicket || printer.printTicket;

  initDb();

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json());

  // Config pubblica per il frontend (branding, valuta, locale) — sempre accessibile
  app.get("/api/config", (req, res) => res.json(publicConfig({
    includeOperators: isAuthenticated(req),
  })));
  // Login (attivo solo se APP_PIN e' impostato) — deve precedere il gate
  app.post("/api/auth/login", loginHandler);

  // Gate d'accesso opzionale con PIN (no-op se APP_PIN non e' impostato)
  app.use(authMiddleware);
  app.post("/api/auth/logout", logoutHandler);

  // Un restore acquisisce un lock esclusivo prima di leggere il file caricato:
  // tutte le route DB successive vengono respinte fino alla conclusione.
  app.use("/api", maintenanceMiddleware);

  app.use("/api/products", products);
  app.use("/api/sales", createSalesRouter({ printTicket }));
  app.use("/api/sessions", sessions);
  app.use("/api/reports", reports);

  // Espone sotto /vendor solo i pacchetti usati dal frontend, non tutto node_modules
  const vendorPackages = ["chart.js", "sortablejs", "@fontsource/onest", "@fontsource/jetbrains-mono"];
  for (const pkg of vendorPackages) {
    app.use(`/vendor/${pkg}`, express.static(path.join(__dirname, "..", "node_modules", pkg)));
  }
  app.use(express.static(path.join(__dirname, "..", "public")));

  // Error handler globale: risposta JSON coerente invece della pagina di default
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    if (status >= 500) console.error("Errore non gestito:", err);
    const message = status < 500 && err.publicMessage
      ? err.publicMessage
      : "Errore interno del server";
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
