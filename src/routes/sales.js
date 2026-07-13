const express = require("express");
const { db, getNextSaleNumber, getOpenSession } = require("../db");
const { MAX_MONEY_CENTS, MAX_QTY, cleanText, isValidCents } = require("../validation");

const PAYMENT_METHODS = new Set(["cash", "card", "other"]);

function loadItems(saleIds) {
  if (saleIds.length === 0) return new Map();
  const placeholders = saleIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT si.sale_id, si.product_id, si.qty, si.unit_price_cents,
           si.line_total_cents, si.product_name AS name,
           si.product_category AS category
    FROM sale_items si
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

    if (items.length > 100) return res.status(400).json({ error: "Troppi articoli nel carrello" });
    const normalized = items.map(it => ({ product_id: it?.product_id, qty: it?.qty }));
    const invalidItem = normalized.some(it =>
      !Number.isSafeInteger(it.product_id) || it.product_id <= 0
      || !Number.isSafeInteger(it.qty) || it.qty <= 0 || it.qty > MAX_QTY
    );
    if (invalidItem) {
      return res.status(400).json({ error: `Ogni articolo deve avere id valido e quantita' tra 1 e ${MAX_QTY}` });
    }

    const ids = normalized.map(i => i.product_id);
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: "Lo stesso prodotto compare piu' volte nel carrello" });
    }
    const placeholders = ids.map(() => "?").join(",");
    const products = db.prepare(`
      SELECT id, name, category, price_cents
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
      return {
        product_id: p.id,
        name: p.name,
        category: p.category,
        qty: it.qty,
        unit_price_cents: unit,
        line_total_cents: line,
      };
    });

    const subtotalCents = computedItems.reduce((a, b) => a + b.line_total_cents, 0);
    if (!isValidCents(subtotalCents, MAX_MONEY_CENTS)) {
      return res.status(400).json({ error: "Totale carrello fuori limite" });
    }

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
        const pct = discount.value;
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          return res.status(400).json({ error: "Percentuale sconto non valida (0-100)" });
        }
        discountType = "percent";
        discountValue = Math.round(pct * 100) / 100;
        discountCents = Math.round(subtotalCents * discountValue / 100);
      } else if (type === "amount") {
        const amt = discount.value;
        if (!isValidCents(amt, MAX_MONEY_CENTS)) {
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
      cashReceivedCents = received === undefined || received === null ? totalCents : received;
      if (!isValidCents(cashReceivedCents, MAX_MONEY_CENTS) || cashReceivedCents < totalCents) {
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
        INSERT INTO sale_items
          (sale_id, product_id, qty, unit_price_cents, line_total_cents,
           product_name, product_category)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const it of computedItems) {
        insItem.run(
          saleId, it.product_id, it.qty, it.unit_price_cents, it.line_total_cents,
          it.name, it.category
        );
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
      console.error(`Stampa vendita #${result.saleNumber} non riuscita: ${err?.message || String(err)}`);
      db.prepare(`
        UPDATE sales
        SET voided=1, void_reason=?, voided_at=datetime('now'), void_operator=?
        WHERE id=?
      `).run("Stampa non riuscita", session.operator, result.saleId);
      return res.status(502).json({
        error: `Stampa non riuscita. Vendita #${String(result.saleNumber).padStart(4, "0")} annullata automaticamente.`,
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
    const requestedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      return res.status(400).json({ error: "Limite non valido" });
    }
    const limit = Math.min(500, requestedLimit);
    const sessionId = req.query.session === undefined ? null : Number(req.query.session);
    if (sessionId !== null && (!Number.isSafeInteger(sessionId) || sessionId <= 0)) {
      return res.status(400).json({ error: "Turno non valido" });
    }

    const rows = sessionId
      ? db.prepare(`
          SELECT * FROM sales WHERE session_id = ? ORDER BY id DESC LIMIT ?
        `).all(sessionId, limit)
      : db.prepare(`
          SELECT * FROM sales ORDER BY id DESC LIMIT ?
        `).all(limit);

    const itemsBySale = loadItems(rows.map(r => r.id));
    const openSession = getOpenSession();
    res.json(rows.map(r => ({
      ...r,
      can_void: !r.voided && r.session_id === openSession?.id,
      items: itemsBySale.get(r.id) || [],
    })));
  });

  // Dettaglio singola vendita
  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Id non valido" });
    const sale = db.prepare("SELECT * FROM sales WHERE id = ?").get(id);
    if (!sale) return res.status(404).json({ error: "Vendita non trovata" });
    const items = loadItems([id]).get(id) || [];
    const openSession = getOpenSession();
    res.json({ ...sale, can_void: !sale.voided && sale.session_id === openSession?.id, items });
  });

  // Storno di una vendita specifica con motivo
  router.post("/:id/void", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Id non valido" });
    const sale = db.prepare("SELECT id, sale_number, session_id, voided FROM sales WHERE id = ?").get(id);
    if (!sale) return res.status(404).json({ error: "Vendita non trovata" });
    if (sale.voided) return res.status(400).json({ error: "Vendita gia' annullata" });

    const openSession = getOpenSession();
    if (!openSession || sale.session_id !== openSession.id) {
      return res.status(409).json({ error: "Non puoi annullare una vendita di un turno chiuso" });
    }

    const reason = cleanText(req.body?.reason || "Storno manuale", 240);
    if (!reason) return res.status(400).json({ error: "Motivo storno non valido" });
    db.prepare(`
      UPDATE sales
      SET voided=1, void_reason=?, voided_at=datetime('now'), void_operator=?
      WHERE id=?
    `).run(reason, openSession.operator, id);
    res.json({ ok: true, sale_number: sale.sale_number });
  });

  // Annulla l'ultima vendita non annullata (retro-compatibile)
  router.post("/void-last", (req, res) => {
    const openSession = getOpenSession();
    if (!openSession) {
      return res.status(409).json({ error: "Nessun turno aperto: non puoi annullare vendite gia' chiuse" });
    }
    const last = db.prepare(`
      SELECT id, sale_number FROM sales
      WHERE voided=0 AND session_id=?
      ORDER BY id DESC
      LIMIT 1
    `).get(openSession.id);

    if (!last) return res.status(404).json({ error: "Nessuna vendita da annullare" });

    db.prepare(`
      UPDATE sales
      SET voided=1, void_reason=?, voided_at=datetime('now'), void_operator=?
      WHERE id=?
    `).run("Annullo ultima vendita", openSession.operator, last.id);
    res.json({ ok: true, sale_number: last.sale_number });
  });

  return router;
}

module.exports = createSalesRouter;
