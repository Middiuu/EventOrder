const express = require("express");
const { db, getOpenSession } = require("../db");
const { MAX_QTY, cleanText } = require("../validation");

const router = express.Router();
const MAX_SUSPENDED_CARTS = 100;
const MAX_CART_ITEMS = 100;

function cartsForSession(sessionId) {
  const carts = db.prepare(`
    SELECT id, session_id, label, operator, created_at
    FROM suspended_carts
    WHERE session_id = ?
    ORDER BY id DESC
  `).all(sessionId);
  if (carts.length === 0) return [];

  const ids = carts.map(cart => cart.id);
  const placeholders = ids.map(() => "?").join(",");
  const items = db.prepare(`
    SELECT sci.cart_id, sci.product_id, sci.qty,
           p.name, p.category, p.price_cents, p.active, p.sold_out, p.stock
    FROM suspended_cart_items sci
    JOIN products p ON p.id = sci.product_id
    WHERE sci.cart_id IN (${placeholders})
    ORDER BY sci.cart_id DESC, p.sort_order ASC, p.name ASC
  `).all(...ids);

  const byCart = new Map();
  for (const item of items) {
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
  const normalized = items.map(item => ({ product_id: item?.product_id, qty: item?.qty }));
  if (normalized.some(item =>
    !Number.isSafeInteger(item.product_id) || item.product_id <= 0
    || !Number.isSafeInteger(item.qty) || item.qty <= 0 || item.qty > MAX_QTY
  )) {
    return res.status(400).json({ error: `Prodotti e quantita' devono essere validi (massimo ${MAX_QTY})` });
  }
  const ids = normalized.map(item => item.product_id);
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: "Lo stesso prodotto compare piu' volte nella comanda" });
  }

  const placeholders = ids.map(() => "?").join(",");
  const existing = db.prepare(`
    SELECT id, name, sold_out, stock FROM products
    WHERE active = 1 AND id IN (${placeholders})
  `).all(...ids);
  if (existing.length !== ids.length) {
    return res.status(409).json({ error: "La comanda contiene prodotti non piu' disponibili nel catalogo" });
  }
  const byId = new Map(existing.map(product => [product.id, product]));
  for (const item of normalized) {
    const product = byId.get(item.product_id);
    if (product.sold_out) {
      return res.status(409).json({ error: `Prodotto esaurito: ${product.name}` });
    }
    if (product.stock != null && product.stock < item.qty) {
      return res.status(409).json({ error: `Scorte insufficienti per ${product.name}: disponibili ${product.stock}` });
    }
  }

  const rawLabel = req.body?.label == null
    ? `Comanda ${currentCount + 1}`
    : req.body.label;
  const label = cleanText(rawLabel, 80);
  if (!label) return res.status(400).json({ error: "Nome comanda non valido (massimo 80 caratteri)" });

  const create = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO suspended_carts (session_id, label, operator)
      VALUES (?, ?, ?)
    `).run(session.id, label, session.operator);
    const cartId = Number(info.lastInsertRowid);
    const insertItem = db.prepare(`
      INSERT INTO suspended_cart_items (cart_id, product_id, qty)
      VALUES (?, ?, ?)
    `);
    for (const item of normalized) insertItem.run(cartId, item.product_id, item.qty);
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
