const express = require("express");
const { db } = require("../db");
const {
  MAX_PRODUCT_PRICE_CENTS,
  MAX_SORT_ORDER,
  MAX_STOCK,
  cleanText,
  isSafeIntegerInRange,
  isValidCents,
  normalizeActive,
} = require("../validation");

const router = express.Router();

// --- Helpers
function cleanName(name) {
  return cleanText(name, 120);
}

// Scorte: undefined = mantieni, null/"" = non tracciate, altrimenti intero >= 0.
function normalizeStock(value, fallback) {
  if (value === undefined) return { ok: true, stock: fallback };
  if (value === null || value === "") return { ok: true, stock: null };
  if (isSafeIntegerInRange(value, 0, MAX_STOCK)) return { ok: true, stock: value };
  return { ok: false };
}

// Costo unitario: undefined = mantieni, null/"" = non tracciato, altrimenti centesimi interi.
function normalizeCost(value, fallback) {
  if (value === undefined) return { ok: true, cost: fallback };
  if (value === null || value === "") return { ok: true, cost: null };
  if (isValidCents(value, MAX_PRODUCT_PRICE_CENTS)) return { ok: true, cost: value };
  return { ok: false };
}

// --- Read (solo attivi per Cassa)
router.get("/", (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, price_cents, category, sort_order, active, sold_out, stock, cost_cents
    FROM products
    WHERE active = 1
    ORDER BY sort_order ASC, name ASC
  `).all();
  res.json(rows);
});

// --- Read (tutti per pagina Prodotti)
router.get("/all", (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, price_cents, category, sort_order, active, sold_out, stock, cost_cents
    FROM products
    ORDER BY active DESC, sort_order ASC, name ASC
  `).all();
  res.json(rows);
});

// --- Reorder (bulk): riordina in un'unica transazione atomica
router.post("/reorder", (req, res) => {
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!order || order.length === 0) {
    return res.status(400).json({ error: "order deve essere un array di id" });
  }

  const ids = order.map(Number);
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) {
    return res.status(400).json({ error: "order contiene id non validi" });
  }

  // Tutti gli id devono esistere e comparire una sola volta
  // (IN deduplica la lista: con duplicati o id inesistenti il conteggio non torna).
  const placeholders = ids.map(() => "?").join(",");
  const found = db.prepare(`
    SELECT COUNT(*) AS c FROM products WHERE id IN (${placeholders})
  `).get(...ids).c;
  if (found !== ids.length) {
    return res.status(400).json({ error: "order contiene id inesistenti o duplicati" });
  }

  const update = db.prepare("UPDATE products SET sort_order=? WHERE id=?");
  const tx = db.transaction((list) => {
    list.forEach((id, idx) => update.run((idx + 1) * 10, id));
  });
  tx(ids);

  res.json({ ok: true });
});

// --- Create
router.post("/", (req, res) => {
  const { name, price_cents, category = "Generale", sort_order = 0, active = 1 } = req.body || {};

  const n = cleanName(name);
  const nextCategory = cleanText(category || "Generale", 80);
  const nextActive = normalizeActive(active, true);
  const nextStock = normalizeStock(req.body?.stock, null);
  const nextCost = normalizeCost(req.body?.cost_cents, null);
  if (!n) return res.status(400).json({ error: "Nome prodotto non valido (massimo 120 caratteri)" });
  if (!isValidCents(price_cents, MAX_PRODUCT_PRICE_CENTS)) {
    return res.status(400).json({ error: "Prezzo non valido: usa un numero intero di centesimi" });
  }
  if (!nextCategory) return res.status(400).json({ error: "Categoria non valida (massimo 80 caratteri)" });
  if (!isSafeIntegerInRange(sort_order, -MAX_SORT_ORDER, MAX_SORT_ORDER)) {
    return res.status(400).json({ error: "Ordine non valido" });
  }
  if (nextActive === null) {
    return res.status(400).json({ error: "Stato attivo non valido" });
  }
  if (!nextStock.ok) {
    return res.status(400).json({ error: "Scorte non valide: usa un intero >= 0 o lascia vuoto" });
  }
  if (!nextCost.ok) {
    return res.status(400).json({ error: "Costo non valido: usa centesimi interi o lascia vuoto" });
  }

  // Unicità nome: case-insensitive + trim
  const exists = db.prepare(`
    SELECT id
    FROM products
    WHERE lower(trim(name)) = lower(trim(?))
    LIMIT 1
  `).get(n);

  if (exists) {
    return res.status(409).json({ error: "Esiste già un prodotto con questo nome" });
  }

  const info = db.prepare(`
    INSERT INTO products (name, price_cents, category, sort_order, active, stock, cost_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    n,
    price_cents,
    nextCategory,
    sort_order,
    nextActive,
    nextStock.stock,
    nextCost.cost
  );

  res.json({ id: info.lastInsertRowid });
});

// --- Update
router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Id non valido" });
  }
  const cur = db.prepare("SELECT * FROM products WHERE id=?").get(id);
  if (!cur) return res.status(404).json({ error: "Prodotto non trovato" });

  const nextName = req.body?.name !== undefined ? cleanName(req.body.name) : cur.name;
  const nextPrice = req.body?.price_cents ?? cur.price_cents;
  const nextCategory = cleanText(req.body?.category ?? cur.category, 80);
  const nextSort = req.body?.sort_order ?? cur.sort_order;
  const nextActive = normalizeActive(req.body?.active, cur.active);
  const nextSoldOut = normalizeActive(req.body?.sold_out, cur.sold_out);
  const nextStock = normalizeStock(req.body?.stock, cur.stock);
  const nextCost = normalizeCost(req.body?.cost_cents, cur.cost_cents);

  if (!nextName) return res.status(400).json({ error: "Nome non valido (massimo 120 caratteri)" });
  if (!isValidCents(nextPrice, MAX_PRODUCT_PRICE_CENTS)) {
    return res.status(400).json({ error: "Prezzo non valido: usa un numero intero di centesimi" });
  }
  if (!nextCategory) return res.status(400).json({ error: "Categoria non valida (massimo 80 caratteri)" });
  if (!isSafeIntegerInRange(nextSort, -MAX_SORT_ORDER, MAX_SORT_ORDER)) {
    return res.status(400).json({ error: "Ordine non valido" });
  }
  if (nextActive === null) return res.status(400).json({ error: "Stato attivo non valido" });
  if (nextSoldOut === null) return res.status(400).json({ error: "Stato esaurito non valido" });
  if (!nextStock.ok) {
    return res.status(400).json({ error: "Scorte non valide: usa un intero >= 0 o lascia vuoto" });
  }
  if (!nextCost.ok) {
    return res.status(400).json({ error: "Costo non valido: usa centesimi interi o lascia vuoto" });
  }

  // Unicità nome: case-insensitive + trim, escludendo questo id
  const clash = db.prepare(`
    SELECT id
    FROM products
    WHERE lower(trim(name)) = lower(trim(?))
      AND id <> ?
    LIMIT 1
  `).get(nextName, id);

  if (clash) {
    return res.status(409).json({ error: "Esiste già un prodotto con questo nome" });
  }

  db.prepare(`
    UPDATE products
    SET name=?, price_cents=?, category=?, sort_order=?, active=?, sold_out=?, stock=?, cost_cents=?
    WHERE id=?
  `).run(
    nextName,
    nextPrice,
    nextCategory,
    nextSort,
    nextActive,
    nextSoldOut,
    nextStock.stock,
    nextCost.cost,
    id
  );

  res.json({ ok: true });
});

// --- Delete (solo prodotti mai venduti: lo storico vendite resta integro)
router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Id non valido" });

  const cur = db.prepare("SELECT id FROM products WHERE id=?").get(id);
  if (!cur) return res.status(404).json({ error: "Prodotto non trovato" });

  const used = db.prepare("SELECT 1 FROM sale_items WHERE product_id=? LIMIT 1").get(id);
  if (used) {
    return res.status(409).json({
      error: "Il prodotto compare in vendite registrate: disattivalo per toglierlo dalla cassa",
    });
  }
  const suspended = db.prepare(
    "SELECT 1 FROM suspended_cart_items WHERE product_id=? LIMIT 1"
  ).get(id);
  if (suspended) {
    return res.status(409).json({
      error: "Il prodotto compare in una comanda sospesa: riprendila o eliminala prima di cancellarlo",
    });
  }

  db.prepare("DELETE FROM products WHERE id=?").run(id);
  res.json({ ok: true });
});

module.exports = router;
