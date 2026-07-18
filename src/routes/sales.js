const express = require("express");
const { db, getNextSaleNumber, getOpenSession } = require("../db");
const {
  hasPendingSaleForSession,
  isSalePending,
  markSalePending,
  unmarkSalePending,
} = require("../pending-sales");
const { cleanText } = require("../validation");
const { loadOptionCatalog, resolveSelectedOptions } = require("../product-options");
const { createCheckoutService } = require("../sales/checkout");
const { createSalesHistory } = require("../sales/history");
const { createSalesPrinting } = require("../sales/printing");
const { createSaleVoiding } = require("../sales/voiding");

const PAYMENT_METHODS = new Set(["cash", "card", "other"]);

function createSalesRouter({ printTicket }) {
  const router = express.Router();
  const checkout = createCheckoutService({
    database: db,
    getNextSaleNumber,
    getOpenSession,
    isSalePending,
    loadOptionCatalog,
    resolveSelectedOptions,
    paymentMethods: PAYMENT_METHODS,
  });
  const history = createSalesHistory({
    database: db,
    getOpenSession,
    isSalePending,
    paymentMethods: PAYMENT_METHODS,
  });
  const printing = createSalesPrinting({
    database: db,
    printTicket,
    markSalePending,
    unmarkSalePending,
  });
  const { voidSale } = createSaleVoiding(db);

  router.post("/print", async (req, res) => {
    let result;
    try {
      result = checkout.execute(req.body, req.get("Idempotency-Key"));
    } catch (error) {
      if (error.response) return res.status(error.status).json(error.response);
      throw error;
    }

    if (result.kind === "replay") return res.json(result.response);

    const printed = await printing.attempt(
      result.saleId,
      result.sessionId,
      result.printPayload
    );
    if (!printed.ok) {
      return res.status(502).json({
        error: `Vendita #${String(result.saleNumber).padStart(4, "0")} registrata, ma stampa non riuscita. Usa Ristampa dallo storico Vendite.`,
        sale_recorded: true,
        sale_number: result.saleNumber,
        total_cents: result.totalCents,
        print_status: printed.state.print_status,
        print_attempts: printed.state.print_attempts,
      });
    }

    res.json({
      ...result.response,
      print_status: printed.state.print_status,
      print_attempts: printed.state.print_attempts,
    });
  });

  router.get("/", (req, res) => {
    res.json(history.list(req.query));
  });

  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Id non valido" });
    }
    const sale = history.findById(id);
    if (!sale) return res.status(404).json({ error: "Vendita non trovata" });
    res.json(sale);
  });

  router.post("/:id/reprint", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Id non valido" });
    }
    if (isSalePending(id)) {
      return res.status(409).json({ error: "Una stampa di questa vendita e' gia' in corso" });
    }

    const loaded = printing.loadPayload(id);
    if (!loaded) return res.status(404).json({ error: "Vendita non trovata" });
    if (loaded.sale.voided) {
      return res.status(409).json({ error: "Non puoi ristampare una vendita annullata" });
    }

    const printed = await printing.attempt(
      loaded.sale.id,
      loaded.sale.session_id,
      loaded.payload
    );
    if (!printed.ok) {
      return res.status(502).json({
        error: `Ristampa della vendita #${String(loaded.sale.sale_number).padStart(4, "0")} non riuscita. La vendita resta registrata.`,
        sale_recorded: true,
        sale_number: loaded.sale.sale_number,
        print_status: printed.state.print_status,
        print_attempts: printed.state.print_attempts,
      });
    }

    res.json({
      ok: true,
      sale_number: loaded.sale.sale_number,
      print_status: printed.state.print_status,
      print_attempts: printed.state.print_attempts,
    });
  });

  router.post("/:id/void", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Id non valido" });
    }
    if (isSalePending(id)) {
      return res.status(409).json({
        error: "Attendi la conclusione della stampa prima di annullare la vendita",
      });
    }
    const sale = db.prepare(
      "SELECT id, sale_number, session_id, voided FROM sales WHERE id = ?"
    ).get(id);
    if (!sale) return res.status(404).json({ error: "Vendita non trovata" });
    if (sale.voided) return res.status(400).json({ error: "Vendita gia' annullata" });

    const openSession = getOpenSession();
    if (!openSession || sale.session_id !== openSession.id) {
      return res.status(409).json({ error: "Non puoi annullare una vendita di un turno chiuso" });
    }

    const reason = cleanText(req.body?.reason || "Storno manuale", 240);
    if (!reason) return res.status(400).json({ error: "Motivo storno non valido" });
    voidSale(id, reason, openSession.operator);
    res.json({ ok: true, sale_number: sale.sale_number });
  });

  router.post("/void-last", (req, res) => {
    const openSession = getOpenSession();
    if (!openSession) {
      return res.status(409).json({
        error: "Nessun turno aperto: non puoi annullare vendite gia' chiuse",
      });
    }
    if (hasPendingSaleForSession(openSession.id)) {
      return res.status(409).json({
        error: "Attendi la conclusione della stampa prima di annullare vendite",
      });
    }
    const last = db.prepare(`
      SELECT id, sale_number FROM sales
      WHERE voided=0 AND session_id=?
      ORDER BY id DESC
      LIMIT 1
    `).get(openSession.id);
    if (!last) return res.status(404).json({ error: "Nessuna vendita da annullare" });

    voidSale(last.id, "Annullo ultima vendita", openSession.operator);
    res.json({ ok: true, sale_number: last.sale_number });
  });

  return router;
}

module.exports = createSalesRouter;
