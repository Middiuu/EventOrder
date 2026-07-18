function sessionTotals(database, sessionId, openingFloatCents) {
  const byMethod = database.prepare(`
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
  const byDirection = database.prepare(`
    SELECT direction, COALESCE(SUM(amount_cents), 0) AS total_cents
    FROM cash_movements
    WHERE session_id = ?
    GROUP BY direction
  `).all(sessionId);
  for (const row of byDirection) movements[row.direction] = row.total_cents;

  return {
    byMethod: totals,
    salesCount,
    revenueCents,
    movementsInCents: movements.in,
    movementsOutCents: movements.out,
    expectedCashCents: Number(openingFloatCents || 0)
      + totals.cash + movements.in - movements.out,
  };
}

function withTotals(database, session) {
  if (!session) return null;
  const movements = database.prepare(`
    SELECT id, direction, amount_cents, reason, operator, created_at
    FROM cash_movements
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(session.id);
  return {
    ...session,
    movements,
    totals: sessionTotals(database, session.id, session.opening_float_cents),
  };
}

function withTotalsBatch(database, sessions) {
  if (sessions.length === 0) return [];
  const ids = sessions.map(session => session.id);
  const placeholders = ids.map(() => "?").join(",");
  const salesRows = database.prepare(`
    SELECT session_id, payment_method, COUNT(*) AS count,
           COALESCE(SUM(total_cents), 0) AS revenue_cents
    FROM sales
    WHERE session_id IN (${placeholders}) AND voided = 0
    GROUP BY session_id, payment_method
  `).all(...ids);
  const movementRows = database.prepare(`
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

module.exports = { sessionTotals, withTotals, withTotalsBatch };
