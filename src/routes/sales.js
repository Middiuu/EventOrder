const express = require("express");
const { db, getNextSaleNumber, getOpenSession } = require("../db");

const PAYMENT_METHODS = new Set(["cash", "card", "other"]);

function loadItems(saleIds) {
  if (saleIds.length === 0) return new Map();
  const placeholders = saleIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT si.sale_id, si.product_id, si.qty, si.unit_price_cents, si.line_total_cents, p.name
    FROM sale_items si
    JOIN products p ON p.id = si.product_id
    WHERE si.sale_id IN (${placeholders})
    ORDER BY si.id ASC
  `).all(...saleIds);

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.sale_id)) map.set(r.sale_id, []);
    map.get(r.sale_id).push(r);
  }
  return map;
}

function createSalesRouter({ printTicket }) {
  const router = express.Router();

  router.post("/print", async (req, res) => {
    const session = getOpenSession();
    if (!session) {
      return res.status(409).json({ error: "Nessun turno di cassa aperto. Apri la cassa prima di vendere." });
    }

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ error: "Carrello vuoto" });

    const paymentMethod = String(req.body?.payment_method || "cash");
    if (!PAYMENT_METHODS.has(paymentMethod)) {
      return res.status(400).json({ error: "Metodo di pagamento non valido" });
    }

    const normalized = items
      .map(it => ({ product_id: Number(it.product_id), qty: Number(it.qty) }))
      .filter(it => Number.isInteger(it.product_id) && Number.isInteger(it.qty) && it.qty > 0);

    if (normalized.length === 0) return res.status(400).json({ error: "Items non validi" });

    const ids = normalized.map(i => i.product_id);
    const placeholders = ids.map(() => "?").join(",");
    const products = db.prepare(`
      SELECT id, name, price_cents
      FROM products
      WHERE active=1 AND id IN (${placeholders})
    `).all(...ids);

    const map = new Map(products.map(p => [p.id, p]));
    for (const it of normalized) {
      if (!map.has(it.product_id)) {
        return res.status(400).json({ error: `Prodotto non valido o non attivo: ${it.product_id}` });
      }
    }

    const computedItems = normalized.map(it => {
      const p = map.get(it.product_id);
      const unit = p.price_cents;
      const line = unit * it.qty;
      return { product_id: p.id, name: p.name, qty: it.qty, unit_price_cents: unit, line_total_cents: line };
    });

    const subtotalCents = computedItems.reduce((a, b) => a + b.line_total_cents, 0);

    // Sconto / omaggio (opzionale): { type: 'percent'|'amount'|'gift', value }
    let discountType = null;
    let discountValue = null;
    let discountCents = 0;
    const discount = req.body?.discount;
    if (discount && discount.type && discount.type !== "none") {
      const type = String(discount.type);
      if (type === "gift") {
        discountType = "gift";
        discountCents = subtotalCents;
      } else if (type === "percent") {
        const pct = Number(discount.value);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          return res.status(400).json({ error: "Percentuale sconto non valida (0-100)" });
        }
        discountType = "percent";
        discountValue = Math.round(pct);
        discountCents = Math.round(subtotalCents * pct / 100);
      } else if (type === "amount") {
        const amt = Number(discount.value);
        if (!Number.isInteger(amt) || amt < 0) {
          return res.status(400).json({ error: "Importo sconto non valido" });
        }
        discountType = "amount";
        discountValue = amt;
        discountCents = Math.min(amt, subtotalCents);
      } else {
        return res.status(400).json({ error: "Tipo di sconto non valido" });
      }
    }

    const totalCents = subtotalCents - discountCents;

    // Contanti: calcolo del resto. Per carta/altro non c'e' resto.
    let cashReceivedCents = null;
    let changeCents = null;
    if (paymentMethod === "cash") {
      const received = req.body?.cash_received_cents;
      // se non specificato assumiamo importo esatto
      cashReceivedCents = received === undefined || received === null ? totalCents : Number(received);
      if (!Number.isInteger(cashReceivedCents) || cashReceivedCents < totalCents) {
        return res.status(400).json({ error: "Contanti ricevuti insufficienti" });
      }
      changeCents = cashReceivedCents - totalCents;
    }

    const tx = db.transaction(() => {
      const saleNumber = getNextSaleNumber();

      const saleInfo = db.prepare(`
        INSERT INTO sales
          (sale_number, total_cents, discount_cents, discount_type, discount_value,
           payment_method, cash_received_cents, change_cents, operator, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(saleNumber, totalCents, discountCents, discountType, discountValue,
             paymentMethod, cashReceivedCents, changeCents, session.operator, session.id);

      const saleId = saleInfo.lastInsertRowid;

      const insItem = db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, qty, unit_price_cents, line_total_cents)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const it of computedItems) {
        insItem.run(saleId, it.product_id, it.qty, it.unit_price_cents, it.line_total_cents);
      }

      const sale = db.prepare("SELECT id, sale_number, total_cents, created_at FROM sales WHERE id=?").get(saleId);
      return { saleId, saleNumber: sale.sale_number, createdAt: sale.created_at };
    });

    const result = tx();

    try {
      await printTicket({
        saleNumber: result.saleNumber,
        createdAt: result.createdAt,
        items: computedItems,
        subtotalCents,
        discountCents,
        discountType,
        discountValue,
        totalCents,
        paymentMethod,
        cashReceivedCents,
        changeCents,
        operator: session.operator,
      });
    } catch (err) {
      db.prepare("UPDATE sales SET voided=1, void_reason=? WHERE id=?")
        .run("Stampa non riuscita", result.saleId);
      return res.status(502).json({
        error: `Stampa non riuscita. Vendita #${String(result.saleNumber).padStart(4, "0")} annullata automaticamente.`,
        details: err?.message || String(err),
      });
    }

    res.json({
      ok: true,
      sale_number: result.saleNumber,
      total_cents: totalCents,
      subtotal_cents: subtotalCents,
      discount_cents: discountCents,
      payment_method: paymentMethod,
      change_cents: changeCents,
    });
  });

  // Elenco vendite recenti (opzionalmente filtrate per turno)
  router.get("/", (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    const sessionId = req.query.session ? Number(req.query.session) : null;

    const rows = sessionId
      ? db.prepare(`
          SELECT * FROM sales WHERE session_id = ? ORDER BY id DESC LIMIT ?
        `).all(sessionId, limit)
      : db.prepare(`
          SELECT * FROM sales ORDER BY id DESC LIMIT ?
        `).all(limit);

    const itemsBySale = loadItems(rows.map(r => r.id));
    res.json(rows.map(r => ({ ...r, items: itemsBySale.get(r.id) || [] })));
  });

  // Dettaglio singola vendita
  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Id non valido" });
    const sale = db.prepare("SELECT * FROM sales WHERE id = ?").get(id);
    if (!sale) return res.status(404).json({ error: "Vendita non trovata" });
    const items = loadItems([id]).get(id) || [];
    res.json({ ...sale, items });
  });

  // Storno di una vendita specifica con motivo
  router.post("/:id/void", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Id non valido" });
    const sale = db.prepare("SELECT id, sale_number, voided FROM sales WHERE id = ?").get(id);
    if (!sale) return res.status(404).json({ error: "Vendita non trovata" });
    if (sale.voided) return res.status(400).json({ error: "Vendita gia' annullata" });

    const reason = String(req.body?.reason || "").trim() || "Storno manuale";
    db.prepare("UPDATE sales SET voided=1, void_reason=? WHERE id=?").run(reason, id);
    res.json({ ok: true, sale_number: sale.sale_number });
  });

  // Annulla l'ultima vendita non annullata (retro-compatibile)
  router.post("/void-last", (req, res) => {
    const last = db.prepare(`
      SELECT id, sale_number FROM sales
      WHERE voided=0
      ORDER BY id DESC
      LIMIT 1
    `).get();

    if (!last) return res.status(404).json({ error: "Nessuna vendita da annullare" });

    db.prepare("UPDATE sales SET voided=1, void_reason=? WHERE id=?").run("Annullo ultima vendita", last.id);
    res.json({ ok: true, sale_number: last.sale_number });
  });

  return router;
}

module.exports = createSalesRouter;
