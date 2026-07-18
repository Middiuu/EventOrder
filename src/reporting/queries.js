function iterateScopedSales(database, scope) {
  return database.prepare(`
    SELECT s.total_cents, s.discount_cents, s.payment_method,
           datetime(s.created_at, 'localtime') AS created_local
    FROM sales s
    WHERE ${scope.where} AND s.voided = 0
  `);
}

function iterateTransactions(database, scope) {
  return database.prepare(`
    SELECT
      s.sale_number,
      datetime(s.created_at, 'localtime') AS created_local,
      s.operator,
      s.payment_method,
      s.discount_cents,
      s.total_cents,
      s.voided,
      s.session_id,
      s.note
    FROM sales s
    WHERE ${scope.where}
    ORDER BY s.sale_number ASC
  `);
}

function iterateScopedItems(database, scope, { includeVoided = true } = {}) {
  const voidedFilter = includeVoided ? "" : "AND s.voided = 0";
  const order = scope.sessionId
    ? "s.id ASC, si.id ASC"
    : "s.created_at ASC, s.id ASC, si.id ASC";
  return database.prepare(`
    SELECT
      s.id AS sale_id,
      s.sale_number,
      datetime(s.created_at, 'localtime') AS created_local,
      s.operator,
      s.session_id,
      s.payment_method,
      s.voided,
      s.note AS sale_note,
      s.total_cents,
      s.discount_cents,
      si.id AS item_id,
      si.product_id,
      si.qty,
      si.unit_price_cents,
      si.line_total_cents,
      si.product_name,
      si.product_category,
      si.product_cost_cents,
      si.options_json,
      si.note AS item_note
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    WHERE ${scope.where} ${voidedFilter}
    ORDER BY ${order}
  `);
}

module.exports = {
  iterateScopedItems,
  iterateScopedSales,
  iterateTransactions,
};
