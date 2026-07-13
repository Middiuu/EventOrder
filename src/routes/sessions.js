const express = require("express");
const { db, getOpenSession } = require("../db");
const { config } = require("../config");
const { MAX_MONEY_CENTS, cleanText, isValidCents } = require("../validation");

const router = express.Router();

// Totali di un turno: incasso per metodo, contanti attesi in cassa.
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

  const expectedCashCents = Number(openingFloatCents || 0) + totals.cash;

  return { byMethod: totals, salesCount, revenueCents, expectedCashCents };
}

function withTotals(session) {
  if (!session) return null;
  return { ...session, totals: sessionTotals(session.id, session.opening_float_cents) };
}

// Turno attualmente aperto (con totali live) o null
router.get("/current", (req, res) => {
  res.json({ session: withTotals(getOpenSession()) || null });
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

// Chiusura turno: confronta contanti contati con quelli attesi
router.post("/close", (req, res) => {
  const open = getOpenSession();
  if (!open) return res.status(404).json({ error: "Nessun turno di cassa aperto" });

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
