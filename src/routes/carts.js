const express = require("express");
const crypto = require("crypto");
const { db, getOpenSession } = require("../db");
const { MAX_PRODUCT_PRICE_CENTS, MAX_QTY, cleanText, isValidCents } = require("../validation");
const { loadOptionCatalog, resolveSelectedOptions } = require("../product-options");

const router = express.Router();
const MAX_SUSPENDED_CARTS = 100;
const MAX_CART_ITEMS = 100;

function cartsForSession(sessionId) {
  const carts = db.prepare(`
    SELECT id, session_id, label, operator, note, created_at
    FROM suspended_carts
    WHERE session_id = ?
    ORDER BY id DESC
  `).all(sessionId);
  if (carts.length === 0) return [];

  const ids = carts.map(cart => cart.id);
  const placeholders = ids.map(() => "?").join(",");
  const items = db.prepare(`
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
    try { item.selected_options = JSON.parse(item.selected_options_json || "[]"); } catch { item.selected_options = []; }
    delete item.selected_options_json;
    if (!byCart.has(item.cart_id)) byCart.set(item.cart_id, []);
    byCart.get(item.cart_id).push(item);
  }
  return carts.map(cart => ({ ...cart, items: byCart.get(cart.id) || [] }));
}

router.get("/", (req, res) => {
  const session = getOpenSession();
  res.json({ carts: session ? cartsForSession(session.id) : [] });
});

router.post("/", (req, res) => {
  const session = getOpenSession();
  if (!session) return res.status(409).json({ error: "Apri la cassa prima di sospendere una comanda" });

  const currentCount = db.prepare(
    "SELECT COUNT(*) AS count FROM suspended_carts WHERE session_id = ?"
  ).get(session.id).count;
  if (currentCount >= MAX_SUSPENDED_CARTS) {
    return res.status(409).json({ error: `Limite di ${MAX_SUSPENDED_CARTS} comande sospese raggiunto` });
  }

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0 || items.length > MAX_CART_ITEMS) {
    return res.status(400).json({ error: `La comanda deve contenere da 1 a ${MAX_CART_ITEMS} prodotti` });
  }
  const normalized = items.map(item => {
    const rawNote = item?.note;
    const note = rawNote == null || String(rawNote).trim() === "" ? null : cleanText(rawNote, 240);
    return {
      product_id: item?.product_id,
      qty: item?.qty,
      selected_option_value_ids: Array.isArray(item?.selected_option_value_ids)
        ? [...item.selected_option_value_ids].sort((a, b) => a - b)
        : [],
      expected_unit_price_cents: item?.expected_unit_price_cents,
      note,
      invalid_note: note === null && rawNote != null && String(rawNote).trim() !== "",
    };
  });
  if (normalized.some(item =>
    !Number.isSafeInteger(item.product_id) || item.product_id <= 0
    || !Number.isSafeInteger(item.qty) || item.qty <= 0 || item.qty > MAX_QTY
    || item.invalid_note
    || item.selected_option_value_ids.length > 50
    || item.selected_option_value_ids.some(id => !Number.isSafeInteger(id) || id <= 0)
    || new Set(item.selected_option_value_ids).size !== item.selected_option_value_ids.length
    || (item.expected_unit_price_cents !== undefined
      && !isValidCents(item.expected_unit_price_cents, MAX_PRODUCT_PRICE_CENTS))
  )) {
    return res.status(400).json({ error: `Prodotti e quantita' devono essere validi (massimo ${MAX_QTY})` });
  }
  for (const item of normalized) delete item.invalid_note;
  const signatures = normalized.map(item => JSON.stringify([
    item.product_id, item.selected_option_value_ids, item.note,
  ]));
  if (new Set(signatures).size !== signatures.length) {
    return res.status(400).json({ error: "La stessa riga compare piu' volte nella comanda" });
  }
  const ids = [...new Set(normalized.map(item => item.product_id))];

  const placeholders = ids.map(() => "?").join(",");
  const existing = db.prepare(`
    SELECT id, name, price_cents, sold_out, stock FROM products
    WHERE active = 1 AND id IN (${placeholders})
  `).all(...ids);
  if (existing.length !== ids.length) {
    return res.status(409).json({ error: "La comanda contiene prodotti non piu' disponibili nel catalogo" });
  }
  const byId = new Map(existing.map(product => [product.id, product]));
  const optionCatalog = loadOptionCatalog(ids);
  const stockRequested = new Map();
  for (const item of normalized) {
    const product = byId.get(item.product_id);
    if (product.sold_out) {
      return res.status(409).json({ error: `Prodotto esaurito: ${product.name}` });
    }
    const resolved = resolveSelectedOptions(item, optionCatalog.get(product.id) || []);
    if (resolved.error) return res.status(409).json({ error: resolved.error });
    const unit = product.price_cents + resolved.selected.reduce((sum, option) => sum + option.price_delta_cents, 0);
    if (!isValidCents(unit, MAX_PRODUCT_PRICE_CENTS)) {
      return res.status(400).json({ error: `Prezzo finale non valido per ${product.name}` });
    }
    if (item.expected_unit_price_cents !== undefined && item.expected_unit_price_cents !== unit) {
      return res.status(409).json({ error: `Il prezzo di ${product.name} e' cambiato. Verifica la comanda` });
    }
    item.selected_options = resolved.selected;
    item.expected_unit_price_cents = unit;
    item.line_key = crypto.createHash("sha256").update(JSON.stringify([
      item.product_id, item.selected_option_value_ids, item.note,
    ])).digest("hex");
    stockRequested.set(product.id, (stockRequested.get(product.id) || 0) + item.qty);
  }
  for (const [productId, qty] of stockRequested) {
    const product = byId.get(productId);
    if (product.stock != null && product.stock < qty) {
      return res.status(409).json({ error: `Scorte insufficienti per ${product.name}: disponibili ${product.stock}` });
    }
  }

  const rawLabel = req.body?.label == null
    ? `Comanda ${currentCount + 1}`
    : req.body.label;
  const label = cleanText(rawLabel, 80);
  if (!label) return res.status(400).json({ error: "Nome comanda non valido (massimo 80 caratteri)" });
  const rawNote = req.body?.note;
  const note = rawNote == null || String(rawNote).trim() === "" ? null : cleanText(rawNote, 500);
  if (note === null && rawNote != null && String(rawNote).trim() !== "") {
    return res.status(400).json({ error: "Nota comanda non valida (massimo 500 caratteri)" });
  }

  const create = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO suspended_carts (session_id, label, operator, note)
      VALUES (?, ?, ?, ?)
    `).run(session.id, label, session.operator, note);
    const cartId = Number(info.lastInsertRowid);
    const insertItem = db.prepare(`
      INSERT INTO suspended_cart_items
        (cart_id, line_key, product_id, qty, selected_options_json, note, expected_unit_price_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of normalized) insertItem.run(
      cartId, item.line_key, item.product_id, item.qty,
      JSON.stringify(item.selected_options), item.note, item.expected_unit_price_cents
    );
    return cartId;
  });

  const cartId = create();
  const cart = cartsForSession(session.id).find(entry => entry.id === cartId);
  res.status(201).json({ cart });
});

router.delete("/:id", (req, res) => {
  const session = getOpenSession();
  if (!session) return res.status(409).json({ error: "Nessun turno di cassa aperto" });
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Comanda sospesa non valida" });
  }
  const result = db.prepare(`
    DELETE FROM suspended_carts WHERE id = ? AND session_id = ?
  `).run(id, session.id);
  if (result.changes !== 1) return res.status(404).json({ error: "Comanda sospesa non trovata" });
  res.json({ ok: true });
});

module.exports = router;
