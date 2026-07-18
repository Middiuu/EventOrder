function cartsForSession(database, sessionId) {
  const carts = database.prepare(`
    SELECT id, session_id, label, operator, note, created_at
    FROM suspended_carts
    WHERE session_id = ?
    ORDER BY id DESC
  `).all(sessionId);
  if (carts.length === 0) return [];

  const ids = carts.map(cart => cart.id);
  const placeholders = ids.map(() => "?").join(",");
  const items = database.prepare(`
    SELECT sci.cart_id, sci.line_key, sci.product_id, sci.qty,
           sci.selected_options_json, sci.note, sci.expected_unit_price_cents,
           p.name, p.category, p.price_cents, p.active, p.sold_out, p.stock
    FROM suspended_cart_items sci
    JOIN products p ON p.id = sci.product_id
    WHERE sci.cart_id IN (${placeholders})
    ORDER BY sci.cart_id DESC, p.sort_order ASC, p.name ASC
  `).all(...ids);

  const byCart = new Map();
  for (const item of items) {
    try {
      item.selected_options = JSON.parse(item.selected_options_json || "[]");
    } catch {
      item.selected_options = [];
    }
    delete item.selected_options_json;
    if (!byCart.has(item.cart_id)) byCart.set(item.cart_id, []);
    byCart.get(item.cart_id).push(item);
  }
  return carts.map(cart => ({ ...cart, items: byCart.get(cart.id) || [] }));
}

module.exports = { cartsForSession };
