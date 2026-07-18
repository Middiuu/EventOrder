const express = require("express");
const { db, getNextSaleNumber, getOpenSession } = require("../db");
const {
  hasPendingSaleForSession,
  isSalePending,
  markSalePending,
  unmarkSalePending,
} = require("../pending-sales");
const {
  MAX_MONEY_CENTS,
  MAX_PRODUCT_PRICE_CENTS,
  MAX_QTY,
  cleanText,
  isValidCents,
} = require("../validation");
const { loadOptionCatalog, resolveSelectedOptions } = require("../product-options");
const { IDEMPOTENCY_KEY_RE, fingerprint } = require("../idempotency");
const { conflictError } = require("../sales/errors");
const { createSalesHistory } = require("../sales/history");
const { createSalesPrinting } = require("../sales/printing");
const { createSaleVoiding } = require("../sales/voiding");

const PAYMENT_METHODS = new Set(["cash", "card", "other"]);

function idempotencyFingerprint(sessionId, normalized, paymentMethod, body) {
  const discount = body?.discount && body.discount.type
    ? { type: String(body.discount.type), value: body.discount.value ?? null }
    : null;
  return fingerprint({
    session_id: sessionId,
    items: normalized,
    payment_method: paymentMethod,
    cash_received_cents: body?.cash_received_cents ?? null,
    note: body?.note ?? null,
    discount,
  });
}

function replayExistingSale(res, clientRequestId, fingerprint) {
  const sale = db.prepare(`
    SELECT id, sale_number, total_cents, discount_cents, payment_method,
           change_cents, request_fingerprint, voided, void_reason,
           print_status, print_attempts
    FROM sales WHERE client_request_id = ?
  `).get(clientRequestId);
  if (!sale) return false;

  if (sale.request_fingerprint !== fingerprint) {
    return res.status(409).json({
      error: "Chiave di incasso gia' usata per una richiesta diversa",
    });
  }
  if (isSalePending(sale.id)) {
    return res.status(409).json({
      error: "Incasso ancora in elaborazione. Attendi un istante e riprova.",
      retryable: true,
    });
  }
  if (sale.voided) {
    return res.status(409).json({
      error: `La vendita #${String(sale.sale_number).padStart(4, "0")} associata a questo tentativo e' stata annullata. Avvia un nuovo incasso.`,
    });
  }
  if (sale.print_status === "pending" || sale.print_status === "failed") {
    const uncertain = sale.print_status === "pending";
    return res.status(409).json({
      error: uncertain
        ? `Vendita #${String(sale.sale_number).padStart(4, "0")} registrata, ma esito stampa incerto. Verifica la stampante e usa Ristampa dallo storico.`
        : `Vendita #${String(sale.sale_number).padStart(4, "0")} registrata, ma stampa non riuscita. Usa Ristampa dallo storico.`,
      sale_recorded: true,
      sale_number: sale.sale_number,
      total_cents: sale.total_cents,
      print_status: sale.print_status,
      print_attempts: sale.print_attempts,
    });
  }

  return res.json({
    ok: true,
    idempotent_replay: true,
    sale_number: sale.sale_number,
    total_cents: sale.total_cents,
    subtotal_cents: sale.total_cents + sale.discount_cents,
    discount_cents: sale.discount_cents,
    payment_method: sale.payment_method,
    change_cents: sale.change_cents,
    print_status: sale.print_status,
    print_attempts: sale.print_attempts,
  });
}

function createSalesRouter({ printTicket }) {
  const router = express.Router();
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
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ error: "Carrello vuoto" });

    const paymentMethod = String(req.body?.payment_method || "cash");
    if (!PAYMENT_METHODS.has(paymentMethod)) {
      return res.status(400).json({ error: "Metodo di pagamento non valido" });
    }

    if (items.length > 100) return res.status(400).json({ error: "Troppi articoli nel carrello" });
    const normalized = items.map(it => {
      const rawNote = it?.note;
      const note = rawNote == null || String(rawNote).trim() === "" ? null : cleanText(rawNote, 240);
      return {
        product_id: it?.product_id,
        qty: it?.qty,
        expected_unit_price_cents: it?.expected_unit_price_cents,
        selected_option_value_ids: Array.isArray(it?.selected_option_value_ids)
          ? [...it.selected_option_value_ids].sort((a, b) => a - b)
          : [],
        note,
        invalid_note: note === null && rawNote != null && String(rawNote).trim() !== "",
      };
    });
    const invalidItem = normalized.some(it =>
      !Number.isSafeInteger(it.product_id) || it.product_id <= 0
      || !Number.isSafeInteger(it.qty) || it.qty <= 0 || it.qty > MAX_QTY
      || (it.expected_unit_price_cents !== undefined
        && !isValidCents(it.expected_unit_price_cents, MAX_PRODUCT_PRICE_CENTS))
      || it.invalid_note
      || it.selected_option_value_ids.length > 50
      || it.selected_option_value_ids.some(id => !Number.isSafeInteger(id) || id <= 0)
      || new Set(it.selected_option_value_ids).size !== it.selected_option_value_ids.length
    );
    if (invalidItem) {
      return res.status(400).json({ error: `Ogni articolo deve avere id valido e quantita' tra 1 e ${MAX_QTY}` });
    }
    for (const item of normalized) delete item.invalid_note;

    const signatures = normalized.map(item => JSON.stringify([
      item.product_id, item.selected_option_value_ids, item.note,
    ]));
    if (new Set(signatures).size !== signatures.length) {
      return res.status(400).json({ error: "La stessa riga compare piu' volte nel carrello" });
    }
    const ids = [...new Set(normalized.map(i => i.product_id))];

    const rawOrderNote = req.body?.note;
    const orderNote = rawOrderNote == null || String(rawOrderNote).trim() === ""
      ? null
      : cleanText(rawOrderNote, 500);
    if (orderNote === null && rawOrderNote != null && String(rawOrderNote).trim() !== "") {
      return res.status(400).json({ error: "Nota comanda non valida (massimo 500 caratteri)" });
    }

    const rawIdempotencyKey = req.get("Idempotency-Key");
    if (!rawIdempotencyKey) {
      return res.status(400).json({ error: "Chiave di incasso obbligatoria" });
    }
    const clientRequestId = String(rawIdempotencyKey).trim();
    if (!IDEMPOTENCY_KEY_RE.test(clientRequestId)) {
      return res.status(400).json({ error: "Chiave di incasso non valida" });
    }
    const priorRequest = db.prepare(
      "SELECT session_id FROM sales WHERE client_request_id = ?"
    ).get(clientRequestId);
    const session = getOpenSession();
    if (!session && !priorRequest) {
      return res.status(409).json({ error: "Nessun turno di cassa aperto. Apri la cassa prima di vendere." });
    }
    const fingerprintSessionId = priorRequest?.session_id ?? session?.id;
    if (!Number.isSafeInteger(fingerprintSessionId)) {
      return res.status(409).json({ error: "La richiesta precedente non e' associata a un turno valido" });
    }
    const requestFingerprint = idempotencyFingerprint(
      fingerprintSessionId, normalized, paymentMethod, req.body
    );
    const replay = replayExistingSale(res, clientRequestId, requestFingerprint);
    if (replay) return replay;

    const placeholders = ids.map(() => "?").join(",");
    const products = db.prepare(`
      SELECT id, name, category, price_cents, sold_out, stock, cost_cents
      FROM products
      WHERE active=1 AND id IN (${placeholders})
    `).all(...ids);

    const map = new Map(products.map(p => [p.id, p]));
    const optionCatalog = loadOptionCatalog(ids);
    const stockRequested = new Map();
    for (const it of normalized) {
      const p = map.get(it.product_id);
      if (!p) {
        return res.status(400).json({ error: `Prodotto non valido o non attivo: ${it.product_id}` });
      }
      if (p.sold_out) {
        return res.status(409).json({ error: `Prodotto esaurito: ${p.name}` });
      }
      stockRequested.set(p.id, (stockRequested.get(p.id) || 0) + it.qty);
    }
    for (const [productId, qty] of stockRequested) {
      const product = map.get(productId);
      if (product.stock != null && product.stock < qty) {
        return res.status(409).json({ error: `Scorte insufficienti per ${product.name}: disponibili ${product.stock}` });
      }
    }

    const computedItems = [];
    for (const it of normalized) {
      const p = map.get(it.product_id);
      const resolved = resolveSelectedOptions(it, optionCatalog.get(p.id) || []);
      if (resolved.error) return res.status(409).json({ error: resolved.error, code: "CATALOG_CHANGED" });
      const optionDelta = resolved.selected.reduce((sum, option) => sum + option.price_delta_cents, 0);
      const unit = p.price_cents + optionDelta;
      if (!isValidCents(unit, MAX_PRODUCT_PRICE_CENTS)) {
        return res.status(400).json({ error: `Prezzo finale non valido per ${p.name}` });
      }
      if (it.expected_unit_price_cents !== undefined && it.expected_unit_price_cents !== unit) {
        return res.status(409).json({
          error: `Il prezzo di ${p.name} e' cambiato. Verifica il nuovo totale.`,
          code: "PRICE_CHANGED",
          product_id: p.id,
          current_price_cents: unit,
        });
      }
      const line = unit * it.qty;
      computedItems.push({
        product_id: p.id,
        name: p.name,
        category: p.category,
        qty: it.qty,
        base_unit_price_cents: p.price_cents,
        unit_price_cents: unit,
        line_total_cents: line,
        cost_cents: p.cost_cents,
        stock_decremented_qty: p.stock == null ? 0 : it.qty,
        options: resolved.selected,
        options_json: JSON.stringify(resolved.selected),
        note: it.note,
        selected_option_value_ids: it.selected_option_value_ids,
      });
    }

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
      // La transazione IMMEDIATE acquisisce il lock di scrittura prima di
      // ricontrollare i prezzi: nessun altro processo può cambiarli tra
      // verifica, creazione della vendita e decremento scorte.
      const currentProducts = db.prepare(`
        SELECT id, name, price_cents, sold_out, stock FROM products
        WHERE active=1 AND id IN (${placeholders})
      `).all(...ids);
      const currentById = new Map(currentProducts.map(product => [product.id, product]));
      const currentOptionCatalog = loadOptionCatalog(ids);
      for (const item of computedItems) {
        const current = currentById.get(item.product_id);
        const resolved = current
          ? resolveSelectedOptions(
            { selected_option_value_ids: item.selected_option_value_ids },
            currentOptionCatalog.get(item.product_id) || []
          )
          : { error: "Prodotto non disponibile" };
        const currentUnit = current && !resolved.error
          ? current.price_cents + resolved.selected.reduce((sum, option) => sum + option.price_delta_cents, 0)
          : null;
        if (!current || resolved.error || currentUnit !== item.unit_price_cents
          || JSON.stringify(resolved.selected || []) !== item.options_json) {
          const err = conflictError(
            current
              ? `Il prezzo di ${current.name} e' cambiato. Verifica il nuovo totale.`
              : `Il prodotto ${item.name} non e' piu' disponibile. Verifica la comanda.`
          );
          err.code = current ? "PRICE_CHANGED" : "CATALOG_CHANGED";
          err.productId = item.product_id;
          err.currentPriceCents = currentUnit;
          throw err;
        }
        const requestedQty = stockRequested.get(item.product_id);
        if (current.sold_out || (current.stock != null && current.stock < requestedQty)) {
          const err = conflictError(
            current.sold_out
              ? `Prodotto esaurito: ${current.name}`
              : `Scorte insufficienti per ${current.name}: disponibili ${current.stock}`
          );
          err.code = "CATALOG_CHANGED";
          err.productId = item.product_id;
          throw err;
        }
      }

      const saleNumber = getNextSaleNumber();

      const saleInfo = db.prepare(`
        INSERT INTO sales
          (sale_number, client_request_id, request_fingerprint,
           total_cents, discount_cents, discount_type, discount_value,
           payment_method, cash_received_cents, change_cents, operator, session_id, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(saleNumber, clientRequestId, requestFingerprint,
             totalCents, discountCents, discountType, discountValue,
             paymentMethod, cashReceivedCents, changeCents, session.operator, session.id, orderNote);

      const saleId = saleInfo.lastInsertRowid;

      const insItem = db.prepare(`
        INSERT INTO sale_items
          (sale_id, product_id, qty, unit_price_cents, base_unit_price_cents, line_total_cents,
           product_name, product_category, product_cost_cents, stock_decremented_qty,
           options_json, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const it of computedItems) {
        insItem.run(
          saleId, it.product_id, it.qty, it.unit_price_cents, it.base_unit_price_cents,
          it.line_total_cents, it.name, it.category, it.cost_cents,
          it.stock_decremented_qty, it.options_json, it.note
        );
      }

      // Decrementa le scorte tracciate (NULL = non tracciate, resta invariato)
      const decStock = db.prepare(`
        UPDATE products SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL
      `);
      for (const [productId, qty] of stockRequested) {
        decStock.run(qty, productId);
      }

      const sale = db.prepare("SELECT id, sale_number, total_cents, created_at FROM sales WHERE id=?").get(saleId);
      return { saleId, saleNumber: sale.sale_number, createdAt: sale.created_at };
    });

    let result;
    try {
      result = tx.immediate();
    } catch (err) {
      if (err.code === "PRICE_CHANGED" || err.code === "CATALOG_CHANGED") {
        return res.status(409).json({
          error: err.publicMessage,
          code: err.code,
          product_id: err.productId,
          current_price_cents: err.currentPriceCents,
        });
      }
      throw err;
    }
    const printed = await printing.attempt(result.saleId, session.id, {
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
      orderNote,
    });
    if (!printed.ok) {
      return res.status(502).json({
        error: `Vendita #${String(result.saleNumber).padStart(4, "0")} registrata, ma stampa non riuscita. Usa Ristampa dallo storico Vendite.`,
        sale_recorded: true,
        sale_number: result.saleNumber,
        total_cents: totalCents,
        print_status: printed.state.print_status,
        print_attempts: printed.state.print_attempts,
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
      print_status: printed.state.print_status,
      print_attempts: printed.state.print_attempts,
    });
  });

  router.get("/", (req, res) => {
    res.json(history.list(req.query));
  });

  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Id non valido" });
    const sale = history.findById(id);
    if (!sale) return res.status(404).json({ error: "Vendita non trovata" });
    res.json(sale);
  });

  // Ristampa esplicita e idempotente rispetto alla vendita: non crea una
  // seconda vendita, ma registra ogni nuovo tentativo sul record esistente.
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

  // Storno di una vendita specifica con motivo
  router.post("/:id/void", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Id non valido" });
    if (isSalePending(id)) {
      return res.status(409).json({ error: "Attendi la conclusione della stampa prima di annullare la vendita" });
    }
    const sale = db.prepare("SELECT id, sale_number, session_id, voided FROM sales WHERE id = ?").get(id);
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

  // Annulla l'ultima vendita non annullata (retro-compatibile)
  router.post("/void-last", (req, res) => {
    const openSession = getOpenSession();
    if (!openSession) {
      return res.status(409).json({ error: "Nessun turno aperto: non puoi annullare vendite gia' chiuse" });
    }
    if (hasPendingSaleForSession(openSession.id)) {
      return res.status(409).json({ error: "Attendi la conclusione della stampa prima di annullare vendite" });
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
