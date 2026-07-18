const express = require("express");
const { db, getDatabaseInstanceId, getOpenSession } = require("../db");
const { config } = require("../config");
const { hasPendingSaleForSession } = require("../pending-sales");
const {
  fingerprint,
  operationRequest,
  parseStoredResponse,
  requestIdFrom,
  storeOperationRequest,
} = require("../idempotency");
const { MAX_MONEY_CENTS, cleanText, isValidCents } = require("../validation");

const router = express.Router();

// Totali di un turno: incasso per metodo, movimenti, contanti attesi in cassa.
function sessionTotals(sessionId, openingFloatCents) {
  const byMethod = db.prepare(`
    SELECT payment_method, COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS revenue_cents
    FROM sales
    WHERE session_id = ? AND voided = 0
    GROUP BY payment_method
  `).all(sessionId);

  const totals = { cash: 0, card: 0, other: 0 };
  let salesCount = 0;
  let revenueCents = 0;
  for (const row of byMethod) {
    if (totals[row.payment_method] === undefined) totals[row.payment_method] = 0;
    totals[row.payment_method] += row.revenue_cents;
    salesCount += row.count;
    revenueCents += row.revenue_cents;
  }

  const movements = { in: 0, out: 0 };
  const byDirection = db.prepare(`
    SELECT direction, COALESCE(SUM(amount_cents), 0) AS total_cents
    FROM cash_movements
    WHERE session_id = ?
    GROUP BY direction
  `).all(sessionId);
  for (const row of byDirection) {
    movements[row.direction] = row.total_cents;
  }

  const expectedCashCents =
    Number(openingFloatCents || 0) + totals.cash + movements.in - movements.out;

  return {
    byMethod: totals,
    salesCount,
    revenueCents,
    movementsInCents: movements.in,
    movementsOutCents: movements.out,
    expectedCashCents,
  };
}

function sessionMovements(sessionId) {
  return db.prepare(`
    SELECT id, direction, amount_cents, reason, operator, created_at
    FROM cash_movements
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(sessionId);
}

function withTotals(session) {
  if (!session) return null;
  return {
    ...session,
    movements: sessionMovements(session.id),
    totals: sessionTotals(session.id, session.opening_float_cents),
  };
}

// Versione batch per gli elenchi: tre query totali (turni, vendite e movimenti)
// invece di due query aggiuntive per ogni singolo turno.
function withTotalsBatch(sessions) {
  if (sessions.length === 0) return [];
  const ids = sessions.map(session => session.id);
  const placeholders = ids.map(() => "?").join(",");

  const salesRows = db.prepare(`
    SELECT session_id, payment_method, COUNT(*) AS count,
           COALESCE(SUM(total_cents), 0) AS revenue_cents
    FROM sales
    WHERE session_id IN (${placeholders}) AND voided = 0
    GROUP BY session_id, payment_method
  `).all(...ids);

  const movementRows = db.prepare(`
    SELECT id, session_id, direction, amount_cents, reason, operator, created_at
    FROM cash_movements
    WHERE session_id IN (${placeholders})
    ORDER BY session_id ASC, id ASC
  `).all(...ids);

  const salesBySession = new Map();
  for (const row of salesRows) {
    if (!salesBySession.has(row.session_id)) salesBySession.set(row.session_id, []);
    salesBySession.get(row.session_id).push(row);
  }
  const movementsBySession = new Map();
  for (const row of movementRows) {
    if (!movementsBySession.has(row.session_id)) movementsBySession.set(row.session_id, []);
    const movement = { ...row };
    delete movement.session_id;
    movementsBySession.get(row.session_id).push(movement);
  }

  return sessions.map(session => {
    const byMethod = { cash: 0, card: 0, other: 0 };
    let salesCount = 0;
    let revenueCents = 0;
    for (const row of salesBySession.get(session.id) || []) {
      if (byMethod[row.payment_method] === undefined) byMethod[row.payment_method] = 0;
      byMethod[row.payment_method] += row.revenue_cents;
      salesCount += row.count;
      revenueCents += row.revenue_cents;
    }

    const movements = movementsBySession.get(session.id) || [];
    let movementsInCents = 0;
    let movementsOutCents = 0;
    for (const movement of movements) {
      if (movement.direction === "in") movementsInCents += movement.amount_cents;
      if (movement.direction === "out") movementsOutCents += movement.amount_cents;
    }
    const expectedCashCents = Number(session.opening_float_cents || 0)
      + byMethod.cash + movementsInCents - movementsOutCents;

    return {
      ...session,
      movements,
      totals: {
        byMethod,
        salesCount,
        revenueCents,
        movementsInCents,
        movementsOutCents,
        expectedCashCents,
      },
    };
  });
}

// Elenco turni (piu' recenti prima) con totali: report delle chiusure
router.get("/", (req, res) => {
  const requestedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    return res.status(400).json({ error: "Limite non valido" });
  }
  const limit = Math.min(200, requestedLimit);
  const rows = db.prepare(`
    SELECT * FROM cash_sessions ORDER BY id DESC LIMIT ?
  `).all(limit);
  res.json({ sessions: withTotalsBatch(rows) });
});

// Turno attualmente aperto (con totali live) o null
router.get("/current", (req, res) => {
  res.json({
    session: withTotals(getOpenSession()) || null,
    database_instance_id: getDatabaseInstanceId(),
  });
});

// Dettaglio/report di un turno specifico
router.get("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Id turno non valido" });
  }
  const session = db.prepare("SELECT * FROM cash_sessions WHERE id = ?").get(id);
  if (!session) return res.status(404).json({ error: "Turno non trovato" });
  res.json({ session: withTotals(session) });
});

// Apertura turno con fondo cassa
router.post("/open", (req, res) => {
  if (getOpenSession()) {
    return res.status(409).json({ error: "Esiste gia' un turno di cassa aperto" });
  }

  const floatCents = req.body?.opening_float_cents;
  if (!isValidCents(floatCents, MAX_MONEY_CENTS)) {
    return res.status(400).json({ error: "Fondo cassa non valido" });
  }

  if (req.body?.operator != null && typeof req.body.operator !== "string") {
    return res.status(400).json({ error: "Nome operatore non valido" });
  }
  const rawOperator = String(req.body?.operator || "").trim();
  const operator = rawOperator ? cleanText(rawOperator, 80) : null;
  if (rawOperator && !operator) {
    return res.status(400).json({ error: "Nome operatore non valido" });
  }
  if (config.OPERATORS.length > 0 && operator && !config.OPERATORS.includes(operator)) {
    return res.status(400).json({ error: "Operatore non riconosciuto" });
  }

  const info = db.prepare(`
    INSERT INTO cash_sessions (opening_float_cents, operator)
    VALUES (?, ?)
  `).run(floatCents, operator);

  const session = db.prepare("SELECT * FROM cash_sessions WHERE id = ?").get(info.lastInsertRowid);
  res.json({ session: withTotals(session) });
});

// Movimento di cassa sul turno aperto: prelievo ('out') o versamento ('in').
// Un errore si corregge registrando il movimento opposto, non cancellando.
router.post("/movements", (req, res) => {
  const requestId = requestIdFrom(req);
  if (!requestId) return res.status(400).json({ error: "Chiave idempotente del movimento obbligatoria o non valida" });

  const direction = req.body?.direction;
  if (direction !== "in" && direction !== "out") {
    return res.status(400).json({ error: "Tipo movimento non valido: usa 'in' o 'out'" });
  }

  const amountCents = req.body?.amount_cents;
  if (!isValidCents(amountCents, MAX_MONEY_CENTS) || amountCents === 0) {
    return res.status(400).json({ error: "Importo non valido: usa centesimi interi maggiori di zero" });
  }

  if (typeof req.body?.reason !== "string") {
    return res.status(400).json({ error: "Il motivo del movimento e' obbligatorio" });
  }
  const reason = cleanText(req.body.reason, 240);
  if (!reason) {
    return res.status(400).json({ error: "Motivo non valido (massimo 240 caratteri)" });
  }

  const prior = operationRequest(db, "cash_movement", requestId);
  const open = getOpenSession();
  const sessionId = prior?.session_id ?? open?.id;
  if (!Number.isSafeInteger(sessionId)) {
    return res.status(409).json({ error: "Nessun turno di cassa aperto" });
  }
  const requestFingerprint = fingerprint({ session_id: sessionId, direction, amount_cents: amountCents, reason });
  if (prior) {
    if (prior.request_fingerprint !== requestFingerprint) {
      return res.status(409).json({ error: "Chiave del movimento gia' usata per una richiesta diversa" });
    }
    parseStoredResponse(prior);
    const priorSession = db.prepare("SELECT * FROM cash_sessions WHERE id = ?").get(prior.session_id);
    if (!priorSession) return res.status(409).json({ error: "Turno del movimento non piu' disponibile" });
    return res.json({ idempotent_replay: true, session: withTotals(priorSession) });
  }
  if (hasPendingSaleForSession(open.id)) {
    return res.status(409).json({ error: "Attendi la conclusione della stampa prima di registrare movimenti" });
  }

  // Un prelievo non puo' superare i contanti attesi in cassa in quel momento.
  if (direction === "out") {
    const { expectedCashCents } = sessionTotals(open.id, open.opening_float_cents);
    if (amountCents > expectedCashCents) {
      return res.status(409).json({ error: "Prelievo superiore ai contanti attesi in cassa" });
    }
  }

  const createMovement = db.transaction(() => {
    const existing = operationRequest(db, "cash_movement", requestId);
    if (existing) return { replay: existing };
    const info = db.prepare(`
      INSERT INTO cash_movements (session_id, direction, amount_cents, reason, operator)
      VALUES (?, ?, ?, ?, ?)
    `).run(open.id, direction, amountCents, reason, open.operator);
    storeOperationRequest(db, {
      operation: "cash_movement",
      requestId,
      requestFingerprint,
      sessionId: open.id,
      response: { movement_id: Number(info.lastInsertRowid) },
    });
    return { movementId: Number(info.lastInsertRowid) };
  });
  const created = createMovement();
  if (created.replay) {
    if (created.replay.request_fingerprint !== requestFingerprint) {
      return res.status(409).json({ error: "Chiave del movimento gia' usata per una richiesta diversa" });
    }
    const replaySession = db.prepare("SELECT * FROM cash_sessions WHERE id = ?").get(created.replay.session_id);
    return res.json({ idempotent_replay: true, session: withTotals(replaySession) });
  }

  const session = db.prepare("SELECT * FROM cash_sessions WHERE id = ?").get(open.id);
  res.json({ movement_id: created.movementId, session: withTotals(session) });
});

// Chiusura turno: confronta contanti contati con quelli attesi
router.post("/close", (req, res) => {
  const open = getOpenSession();
  if (!open) return res.status(404).json({ error: "Nessun turno di cassa aperto" });
  if (hasPendingSaleForSession(open.id)) {
    return res.status(409).json({ error: "Attendi la conclusione della stampa prima di chiudere la cassa" });
  }
  const suspendedCount = db.prepare(
    "SELECT COUNT(*) AS count FROM suspended_carts WHERE session_id = ?"
  ).get(open.id).count;
  if (suspendedCount > 0) {
    return res.status(409).json({
      error: `Ci sono ${suspendedCount} comand${suspendedCount === 1 ? "a sospesa" : "e sospese"}: riprendile o eliminale prima di chiudere la cassa`,
    });
  }

  const countedCents = req.body?.counted_cash_cents;
  if (!isValidCents(countedCents, MAX_MONEY_CENTS)) {
    return res.status(400).json({ error: "Conteggio contanti non valido" });
  }

  const { expectedCashCents } = sessionTotals(open.id, open.opening_float_cents);
  const differenceCents = countedCents - expectedCashCents;
  if (req.body?.note != null && typeof req.body.note !== "string") {
    return res.status(400).json({ error: "Nota non valida" });
  }
  const rawNote = String(req.body?.note || "").trim();
  const note = rawNote ? cleanText(rawNote, 500) : null;
  if (rawNote && !note) return res.status(400).json({ error: "Nota troppo lunga" });

  db.prepare(`
    UPDATE cash_sessions
    SET closed_at = datetime('now'),
        counted_cash_cents = ?,
        expected_cash_cents = ?,
        difference_cents = ?,
        note = COALESCE(?, note)
    WHERE id = ?
  `).run(countedCents, expectedCashCents, differenceCents, note, open.id);

  const session = db.prepare("SELECT * FROM cash_sessions WHERE id = ?").get(open.id);
  res.json({ session: withTotals(session) });
});

module.exports = router;
