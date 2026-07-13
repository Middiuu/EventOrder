const express = require("express");
const { db } = require("../db");

const router = express.Router();

// --- Helpers
function cleanName(name) {
  return String(name || "").trim();
}

// --- Read (solo attivi per Cassa)
router.get("/", (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, price_cents, category, sort_order, active
    FROM products
    WHERE active = 1
    ORDER BY sort_order ASC, name ASC
  `).all();
  res.json(rows);
});

// --- Read (tutti per pagina Prodotti)
router.get("/all", (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, price_cents, category, sort_order, active
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
  if (!n || typeof price_cents !== "number" || price_cents < 0) {
    return res.status(400).json({ error: "name e price_cents sono obbligatori" });
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
    INSERT INTO products (name, price_cents, category, sort_order, active)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    n,
    Number(price_cents),
    String(category || "Generale"),
    Number(sort_order) || 0,
    active ? 1 : 0
  );

  res.json({ id: info.lastInsertRowid });
});

// --- Update
router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare("SELECT * FROM products WHERE id=?").get(id);
  if (!cur) return res.status(404).json({ error: "Prodotto non trovato" });

  const nextName = req.body?.name !== undefined ? cleanName(req.body.name) : cur.name;
  const nextPrice = req.body?.price_cents ?? cur.price_cents;
  const nextCategory = req.body?.category ?? cur.category;
  const nextSort = req.body?.sort_order ?? cur.sort_order;
  const nextActive = (req.body?.active ?? cur.active) ? 1 : 0;

  if (!nextName) return res.status(400).json({ error: "Nome non valido" });
  if (typeof nextPrice !== "number" || nextPrice < 0) {
    return res.status(400).json({ error: "Prezzo non valido" });
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
    SET name=?, price_cents=?, category=?, sort_order=?, active=?
    WHERE id=?
  `).run(
    nextName,
    Number(nextPrice),
    String(nextCategory || "Generale"),
    Number(nextSort) || 0,
    nextActive,
    id
  );

  res.json({ ok: true });
});

// --- Delete (solo prodotti mai venduti: lo storico vendite resta integro)
router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Id non valido" });

  const cur = db.prepare("SELECT id FROM products WHERE id=?").get(id);
  if (!cur) return res.status(404).json({ error: "Prodotto non trovato" });

  const used = db.prepare("SELECT 1 FROM sale_items WHERE product_id=? LIMIT 1").get(id);
  if (used) {
    return res.status(409).json({
      error: "Il prodotto compare in vendite registrate: disattivalo per toglierlo dalla cassa",
    });
  }

  db.prepare("DELETE FROM products WHERE id=?").run(id);
  res.json({ ok: true });
});

module.exports = router;