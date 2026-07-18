const { conflictError } = require("./errors");

function createSaleVoiding(database) {
  function expectedCashForSession(sessionId) {
    return database.prepare(`
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

  function voidSale(saleId, reason, operator, protectExpectedCash = true) {
    // La transazione viene creata sulla connessione corrente a ogni invocazione,
    // quindi non resta legata al file SQLite sostituito da un restore.
    return database.transaction(() => {
      const sale = database.prepare(`
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

      const updated = database.prepare(`
        UPDATE sales
        SET voided=1, void_reason=?, voided_at=datetime('now'), void_operator=?
        WHERE id=? AND voided=0
      `).run(reason, operator, saleId);
      if (updated.changes !== 1) return false;

      const items = database.prepare(`
        SELECT product_id, stock_decremented_qty
        FROM sale_items WHERE sale_id=?
      `).all(saleId);
      const incrementStock = database.prepare(`
        UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL
      `);
      for (const item of items) {
        if (item.stock_decremented_qty > 0) {
          incrementStock.run(item.stock_decremented_qty, item.product_id);
        }
      }
      return true;
    })();
  }

  return { voidSale };
}

module.exports = { createSaleVoiding };
