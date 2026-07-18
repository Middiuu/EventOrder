function loadSaleItems(database, saleIds) {
  if (saleIds.length === 0) return new Map();
  const placeholders = saleIds.map(() => "?").join(",");
  const rows = database.prepare(`
    SELECT si.sale_id, si.product_id, si.qty, si.unit_price_cents,
           si.base_unit_price_cents, si.options_json, si.note,
           si.line_total_cents, si.product_name AS name,
           si.product_category AS category
    FROM sale_items si
    WHERE si.sale_id IN (${placeholders})
    ORDER BY si.id ASC
  `).all(...saleIds);

  const itemsBySale = new Map();
  for (const row of rows) {
    try {
      row.options = JSON.parse(row.options_json || "[]");
    } catch {
      row.options = [];
    }
    delete row.options_json;
    if (!itemsBySale.has(row.sale_id)) itemsBySale.set(row.sale_id, []);
    itemsBySale.get(row.sale_id).push(row);
  }
  return itemsBySale;
}

module.exports = { loadSaleItems };
