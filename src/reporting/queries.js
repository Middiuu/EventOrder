function loadScopedSales(database, scope, { includeVoided = false } = {}) {
  const voidedFilter = includeVoided ? "" : "AND s.voided = 0";
  const sales = database.prepare(`
    SELECT s.id, s.sale_number, s.total_cents, s.discount_cents, s.payment_method,
           s.operator, s.session_id, s.note, s.voided,
           datetime(s.created_at, 'localtime') AS created_local
    FROM sales s
    WHERE ${scope.where} ${voidedFilter}
    ORDER BY s.id ASC
  `).all(...scope.params);

  const itemsBySale = new Map();
  if (sales.length > 0) {
    const items = database.prepare(`
      SELECT si.id, si.sale_id, si.product_id, si.qty, si.unit_price_cents,
             si.line_total_cents, si.product_name, si.product_category,
             si.product_cost_cents, si.options_json, si.note
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE ${scope.where} ${voidedFilter}
      ORDER BY si.id ASC
    `).all(...scope.params);
    for (const item of items) {
      if (!itemsBySale.has(item.sale_id)) itemsBySale.set(item.sale_id, []);
      itemsBySale.get(item.sale_id).push(item);
    }
  }
  return { sales, itemsBySale };
}

function loadTransactions(database, scope) {
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
  `).all(...scope.params);
}

module.exports = { loadScopedSales, loadTransactions };
