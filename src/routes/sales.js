const express = require("express");
const crypto = require("crypto");
const { db, getNextSaleNumber, getOpenSession } = require("../db");
const {
  hasPendingSaleForSession,
  isSalePending,
  markSalePending,
  unmarkSalePending,
} = require("../pending-sales");
const {
  MAX_MONEY_CENTS,
  MAX_QTY,
  cleanText,
  isValidCents,
  localYmdToUtcSql,
  parseLocalYmd,
} = require("../validation");

const PAYMENT_METHODS = new Set(["cash", "card", "other"]);
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,120}$/;

function idempotencyFingerprint(sessionId, normalized, paymentMethod, body) {
  const discount = body?.discount && body.discount.type
    ? { type: String(body.discount.type), value: body.discount.value ?? null }
    : null;
  const canonical = JSON.stringify({
    session_id: sessionId,
    items: normalized,
    payment_method: paymentMethod,
    cash_received_cents: body?.cash_received_cents ?? null,
    discount,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
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

function conflictError(message) {
  const err = new Error(message);
  err.status = 409;
  err.publicMessage = message;
  return err;
}

function printableError(err) {
  const message = String(err?.message || err || "Errore stampante")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return (message || "Errore stampante").slice(0, 500);
}

function beginPrintAttempt(saleId) {
  db.prepare(`
    UPDATE sales
    SET print_status='pending', print_attempts=print_attempts+1,
        last_print_error=NULL, last_print_attempt_at=datetime('now')
    WHERE id=? AND voided=0
  `).run(saleId);
}

function completePrintAttempt(saleId) {
  db.prepare(`
    UPDATE sales
    SET print_status='printed', last_print_error=NULL,
        last_printed_at=datetime('now')
    WHERE id=? AND voided=0
  `).run(saleId);
}

function failPrintAttempt(saleId, message) {
  db.prepare(`
    UPDATE sales
    SET print_status='failed', last_print_error=?
    WHERE id=? AND voided=0
  `).run(message, saleId);
}

function printState(saleId) {
  return db.prepare(`
    SELECT print_status, print_attempts, last_print_error,
           last_print_attempt_at, last_printed_at
    FROM sales WHERE id=?
  `).get(saleId);
}

function expectedCashForSession(sessionId) {
  return db.prepare(`
    SELECT
      cs.opening_float_cents
      + COALESCE((
          SELECT SUM(s.total_cents) FROM sales s
          WHERE s.session_id = cs.id AND s.voided = 0 AND s.payment_method = 'cash'
        ), 0)
      + COALESCE((
          SELECT SUM(cm.amount_cents) FROM cash_movements cm
          WHERE cm.session_id = cs.id AND cm.direction = 'in'
        ), 0)
      - COALESCE((
          SELECT SUM(cm.amount_cents) FROM cash_movements cm
          WHERE cm.session_id = cs.id AND cm.direction = 'out'
        ), 0) AS expected_cash_cents
    FROM cash_sessions cs
    WHERE cs.id = ?
  `).get(sessionId)?.expected_cash_cents;
}

// Storno idempotente con ripristino della sola quantità effettivamente
// decrementata alla vendita. Gli storni manuali proteggono inoltre l'invariante
// dei contanti attesi, evitando di lasciare il turno in uno stato non chiudibile.
function voidSale(saleId, reason, operator, protectExpectedCash = true) {
  // La transazione viene costruita sulla connessione corrente: dopo un restore
  // non deve restare legata all'istanza SQLite che e' stata chiusa.
  return db.transaction(() => {
    const sale = db.prepare(`
      SELECT id, session_id, payment_method, total_cents, voided
      FROM sales WHERE id = ?
    `).get(saleId);
    if (!sale || sale.voided) return false;

    if (protectExpectedCash && sale.payment_method === "cash") {
      const expected = expectedCashForSession(sale.session_id);
      if (expected != null && expected - sale.total_cents < 0) {
        throw conflictError(
          "Lo storno renderebbe negativi i contanti attesi. Registra prima un versamento di cassa sufficiente."
        );
      }
    }

    const updated = db.prepare(`
      UPDATE sales
      SET voided=1, void_reason=?, voided_at=datetime('now'), void_operator=?
      WHERE id=? AND voided=0
    `).run(reason, operator, saleId);
    if (updated.changes !== 1) return false;

    const items = db.prepare(`
      SELECT product_id, stock_decremented_qty
      FROM sale_items WHERE sale_id=?
    `).all(saleId);
    const incStock = db.prepare(`
      UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL
    `);
    for (const it of items) {
      if (it.stock_decremented_qty > 0) {
        incStock.run(it.stock_decremented_qty, it.product_id);
      }
    }
    return true;
  })();
}

function createSalesRouter({ printTicket }) {
  const router = express.Router();

  async function attemptSalePrint(saleId, sessionId, payload) {
    markSalePending(saleId, sessionId);
    try {
      beginPrintAttempt(saleId);
      await printTicket(payload);
      completePrintAttempt(saleId);
      return { ok: true, state: printState(saleId) };
    } catch (err) {
      const message = printableError(err);
      console.error(`Stampa vendita #${payload.saleNumber} non riuscita: ${message}`);
      failPrintAttempt(saleId, message);
      return { ok: false, message, state: printState(saleId) };
    } finally {
      unmarkSalePending(saleId);
    }
  }

  function loadPrintPayload(saleId) {
    const sale = db.prepare(`
      SELECT id, sale_number, created_at, total_cents, discount_cents,
             discount_type, discount_value, payment_method,
             cash_received_cents, change_cents, operator, session_id, voided
      FROM sales WHERE id=?
    `).get(saleId);
    if (!sale) return null;
    const items = loadItems([saleId]).get(saleId) || [];
    return {
      sale,
      payload: {
        saleNumber: sale.sale_number,
        createdAt: sale.created_at,
        items,
        subtotalCents: sale.total_cents + sale.discount_cents,
        discountCents: sale.discount_cents,
        discountType: sale.discount_type,
        discountValue: sale.discount_value,
        totalCents: sale.total_cents,
        paymentMethod: sale.payment_method,
        cashReceivedCents: sale.cash_received_cents,
        changeCents: sale.change_cents,
        operator: sale.operator,
      },
    };
  }

  router.post("/print", async (req, res) => {
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
    for (const it of normalized) {
      const p = map.get(it.product_id);
      if (!p) {
        return res.status(400).json({ error: `Prodotto non valido o non attivo: ${it.product_id}` });
      }
      if (p.sold_out) {
        return res.status(409).json({ error: `Prodotto esaurito: ${p.name}` });
      }
      if (p.stock != null && p.stock < it.qty) {
        return res.status(409).json({ error: `Scorte insufficienti per ${p.name}: disponibili ${p.stock}` });
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
        cost_cents: p.cost_cents,
        stock_decremented_qty: p.stock == null ? 0 : it.qty,
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
          (sale_number, client_request_id, request_fingerprint,
           total_cents, discount_cents, discount_type, discount_value,
           payment_method, cash_received_cents, change_cents, operator, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(saleNumber, clientRequestId, requestFingerprint,
             totalCents, discountCents, discountType, discountValue,
             paymentMethod, cashReceivedCents, changeCents, session.operator, session.id);

      const saleId = saleInfo.lastInsertRowid;

      const insItem = db.prepare(`
        INSERT INTO sale_items
          (sale_id, product_id, qty, unit_price_cents, line_total_cents,
           product_name, product_category, product_cost_cents, stock_decremented_qty)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const it of computedItems) {
        insItem.run(
          saleId, it.product_id, it.qty, it.unit_price_cents, it.line_total_cents,
          it.name, it.category, it.cost_cents, it.stock_decremented_qty
        );
      }

      // Decrementa le scorte tracciate (NULL = non tracciate, resta invariato)
      const decStock = db.prepare(`
        UPDATE products SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL
      `);
      for (const it of computedItems) {
        decStock.run(it.qty, it.product_id);
      }

      const sale = db.prepare("SELECT id, sale_number, total_cents, created_at FROM sales WHERE id=?").get(saleId);
      return { saleId, saleNumber: sale.sale_number, createdAt: sale.created_at };
    });

    const result = tx();
    const printed = await attemptSalePrint(result.saleId, session.id, {
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

  // Elenco vendite recenti, filtrabile per numero, data, prodotto,
  // operatore, metodo, stato e turno.
  router.get("/", (req, res) => {
    const requestedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      return res.status(400).json({ error: "Limite non valido" });
    }
    const limit = Math.min(500, requestedLimit);

    const where = [];
    const params = [];

    if (req.query.session !== undefined) {
      const sessionId = Number(req.query.session);
      if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({ error: "Turno non valido" });
      }
      where.push("session_id = ?");
      params.push(sessionId);
    }

    if (req.query.number !== undefined && req.query.number !== "") {
      const number = Number(req.query.number);
      if (!Number.isSafeInteger(number) || number <= 0) {
        return res.status(400).json({ error: "Numero vendita non valido" });
      }
      where.push("sale_number = ?");
      params.push(number);
    }

    // Date locali inclusive (from <= giorno <= to)
    if (req.query.from) {
      if (!parseLocalYmd(req.query.from)) {
        return res.status(400).json({ error: "Data 'from' non valida: usa YYYY-MM-DD" });
      }
      where.push("created_at >= ?");
      params.push(localYmdToUtcSql(req.query.from));
    }
    if (req.query.to) {
      if (!parseLocalYmd(req.query.to)) {
        return res.status(400).json({ error: "Data 'to' non valida: usa YYYY-MM-DD" });
      }
      where.push("created_at < ?");
      params.push(localYmdToUtcSql(req.query.to, 1));
    }

    if (req.query.operator) {
      const operator = cleanText(String(req.query.operator), 80);
      if (!operator) return res.status(400).json({ error: "Operatore non valido" });
      where.push("operator LIKE ?");
      params.push(`%${operator}%`);
    }

    if (req.query.product) {
      const product = cleanText(String(req.query.product), 120);
      if (!product) return res.status(400).json({ error: "Prodotto non valido" });
      where.push("EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = sales.id AND si.product_name LIKE ?)");
      params.push(`%${product}%`);
    }

    if (req.query.method) {
      const method = String(req.query.method);
      if (!PAYMENT_METHODS.has(method)) {
        return res.status(400).json({ error: "Metodo di pagamento non valido" });
      }
      where.push("payment_method = ?");
      params.push(method);
    }

    if (req.query.status) {
      const status = String(req.query.status);
      if (status !== "valid" && status !== "voided") {
        return res.status(400).json({ error: "Stato non valido: usa 'valid' o 'voided'" });
      }
      where.push("voided = ?");
      params.push(status === "voided" ? 1 : 0);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT * FROM sales ${whereSql} ORDER BY id DESC LIMIT ?
    `).all(...params, limit);

    const itemsBySale = loadItems(rows.map(r => r.id));
    const openSession = getOpenSession();
    res.json(rows.map(r => ({
      ...r,
      can_void: !r.voided && r.session_id === openSession?.id,
      can_reprint: !r.voided && !isSalePending(r.id),
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
    res.json({
      ...sale,
      can_void: !sale.voided && sale.session_id === openSession?.id,
      can_reprint: !sale.voided && !isSalePending(sale.id),
      items,
    });
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

    const loaded = loadPrintPayload(id);
    if (!loaded) return res.status(404).json({ error: "Vendita non trovata" });
    if (loaded.sale.voided) {
      return res.status(409).json({ error: "Non puoi ristampare una vendita annullata" });
    }

    const printed = await attemptSalePrint(
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
