const express = require("express");
const crypto = require("crypto");
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
const MAX_OPTION_GROUPS = 10;
const MAX_OPTION_VALUES = 20;

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

function normalizeOptionGroups(value) {
  if (value === undefined) return { ok: true, groups: undefined };
  if (!Array.isArray(value) || value.length > MAX_OPTION_GROUPS) {
    return { ok: false, error: `Le opzioni devono avere al massimo ${MAX_OPTION_GROUPS} gruppi` };
  }
  const groups = [];
  for (let groupIndex = 0; groupIndex < value.length; groupIndex += 1) {
    const raw = value[groupIndex] || {};
    const groupId = raw.id === undefined ? null : raw.id;
    const name = cleanText(raw.name, 80);
    const selectionType = raw.selection_type === "multiple" ? "multiple" : raw.selection_type === "single" ? "single" : null;
    const required = normalizeActive(raw.required, false);
    const options = Array.isArray(raw.options) ? raw.options : null;
    if ((groupId !== null && (!Number.isSafeInteger(groupId) || groupId <= 0))
      || !name || !selectionType || required === null || !options || options.length === 0 || options.length > MAX_OPTION_VALUES) {
      return { ok: false, error: `Gruppo opzioni ${groupIndex + 1} non valido` };
    }
    const normalizedOptions = [];
    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      const option = options[optionIndex] || {};
      const optionId = option.id === undefined ? null : option.id;
      const optionName = cleanText(option.name, 80);
      const delta = option.price_delta_cents ?? 0;
      if ((optionId !== null && (!Number.isSafeInteger(optionId) || optionId <= 0))
        || !optionName || !isSafeIntegerInRange(delta, -MAX_PRODUCT_PRICE_CENTS, MAX_PRODUCT_PRICE_CENTS)) {
        return { ok: false, error: `Opzione ${optionIndex + 1} del gruppo ${name} non valida` };
      }
      normalizedOptions.push({ id: optionId, name: optionName, price_delta_cents: delta, sort_order: optionIndex * 10 });
    }
    const names = normalizedOptions.map(option => option.name.toLocaleLowerCase("it-IT"));
    if (new Set(names).size !== names.length) {
      return { ok: false, error: `Il gruppo ${name} contiene opzioni duplicate` };
    }
    groups.push({ id: groupId, name, selection_type: selectionType, required, sort_order: groupIndex * 10, options: normalizedOptions });
  }
  const groupNames = groups.map(group => group.name.toLocaleLowerCase("it-IT"));
  if (new Set(groupNames).size !== groupNames.length) {
    return { ok: false, error: "I gruppi di opzioni devono avere nomi diversi" };
  }
  return { ok: true, groups };
}

function replaceProductOptions(productId, groups) {
  // Libera temporaneamente i nomi esistenti: in questo modo anche scambi come
  // "Piccolo" <-> "Grande" restano atomici e non urtano gli indici UNIQUE
  // durante lo stato intermedio. Un rollback ripristina comunque ogni nome.
  const temporaryPrefix = `__eo_${crypto.randomUUID()}_`;
  db.prepare(`
    UPDATE product_option_values
    SET name = ? || id
    WHERE group_id IN (SELECT id FROM product_option_groups WHERE product_id = ?)
  `).run(temporaryPrefix, productId);
  db.prepare(`
    UPDATE product_option_groups SET name = ? || id WHERE product_id = ?
  `).run(temporaryPrefix, productId);

  const insertGroup = db.prepare(`
    INSERT INTO product_option_groups (product_id, name, selection_type, required, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertOption = db.prepare(`
    INSERT INTO product_option_values (group_id, name, price_delta_cents, sort_order)
    VALUES (?, ?, ?, ?)
  `);
  const updateGroup = db.prepare(`
    UPDATE product_option_groups
    SET name=?, selection_type=?, required=?, sort_order=?, active=1
    WHERE id=? AND product_id=?
  `);
  const updateOption = db.prepare(`
    UPDATE product_option_values
    SET name=?, price_delta_cents=?, sort_order=?, active=1
    WHERE id=? AND group_id=?
  `);
  const keptGroupIds = [];
  for (const group of groups) {
    let groupId = group.id;
    if (groupId !== null) {
      const updated = updateGroup.run(
        group.name, group.selection_type, group.required, group.sort_order, groupId, productId
      );
      if (updated.changes !== 1) throw new Error("Gruppo opzioni non associato al prodotto");
    } else {
      groupId = Number(insertGroup.run(
        productId, group.name, group.selection_type, group.required, group.sort_order
      ).lastInsertRowid);
    }
    keptGroupIds.push(groupId);
    const keptOptionIds = [];
    for (const option of group.options) {
      let optionId = option.id;
      if (optionId !== null) {
        const updated = updateOption.run(
          option.name, option.price_delta_cents, option.sort_order, optionId, groupId
        );
        if (updated.changes !== 1) throw new Error("Scelta non associata al gruppo opzioni");
      } else {
        optionId = Number(insertOption.run(
          groupId, option.name, option.price_delta_cents, option.sort_order
        ).lastInsertRowid);
      }
      keptOptionIds.push(optionId);
    }
    const optionPlaceholders = keptOptionIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM product_option_values WHERE group_id=? AND id NOT IN (${optionPlaceholders})`)
      .run(groupId, ...keptOptionIds);
  }
  if (keptGroupIds.length === 0) {
    db.prepare("DELETE FROM product_option_groups WHERE product_id=?").run(productId);
  } else {
    const groupPlaceholders = keptGroupIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM product_option_groups WHERE product_id=? AND id NOT IN (${groupPlaceholders})`)
      .run(productId, ...keptGroupIds);
  }
}

function optionIdsBelongToProduct(productId, groups) {
  for (const group of groups) {
    if (group.id !== null) {
      const found = db.prepare("SELECT 1 FROM product_option_groups WHERE id=? AND product_id=?").get(group.id, productId);
      if (!found) return false;
    }
    for (const option of group.options) {
      if (option.id !== null) {
        if (group.id === null) return false;
        const found = db.prepare(`
          SELECT 1 FROM product_option_values v
          JOIN product_option_groups g ON g.id=v.group_id
          WHERE v.id=? AND g.product_id=? AND (? IS NULL OR g.id=?)
        `).get(option.id, productId, group.id, group.id);
        if (!found) return false;
      }
    }
  }
  return true;
}

function withProductOptions(rows, { activeOnly = false } = {}) {
  if (rows.length === 0) return rows;
  const ids = rows.map(row => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const activeSql = activeOnly ? "AND g.active=1 AND v.active=1" : "";
  const options = db.prepare(`
    SELECT g.id AS group_id, g.product_id, g.name AS group_name,
           g.selection_type, g.required, g.sort_order AS group_sort_order,
           g.active AS group_active, v.id, v.name, v.price_delta_cents,
           v.sort_order, v.active
    FROM product_option_groups g
    JOIN product_option_values v ON v.group_id = g.id
    WHERE g.product_id IN (${placeholders}) ${activeSql}
    ORDER BY g.product_id, g.sort_order, g.id, v.sort_order, v.id
  `).all(...ids);
  const byProduct = new Map();
  for (const option of options) {
    if (!byProduct.has(option.product_id)) byProduct.set(option.product_id, []);
    const groups = byProduct.get(option.product_id);
    let group = groups.find(candidate => candidate.id === option.group_id);
    if (!group) {
      group = {
        id: option.group_id,
        name: option.group_name,
        selection_type: option.selection_type,
        required: option.required,
        sort_order: option.group_sort_order,
        active: option.group_active,
        options: [],
      };
      groups.push(group);
    }
    group.options.push({
      id: option.id,
      name: option.name,
      price_delta_cents: option.price_delta_cents,
      sort_order: option.sort_order,
      active: option.active,
    });
  }
  return rows.map(row => ({ ...row, option_groups: byProduct.get(row.id) || [] }));
}

// --- Read (solo attivi per Cassa)
router.get("/", (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, price_cents, category, sort_order, active, sold_out, stock, cost_cents
    FROM products
    WHERE active = 1
    ORDER BY sort_order ASC, name ASC
  `).all();
  res.json(withProductOptions(rows, { activeOnly: true }));
});

// --- Read (tutti per pagina Prodotti)
router.get("/all", (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, price_cents, category, sort_order, active, sold_out, stock, cost_cents
    FROM products
    ORDER BY active DESC, sort_order ASC, name ASC
  `).all();
  res.json(withProductOptions(rows));
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
  const nextOptions = normalizeOptionGroups(req.body?.option_groups);
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
  if (!nextOptions.ok) return res.status(400).json({ error: nextOptions.error });
  if (nextOptions.groups?.some(group => group.id !== null || group.options.some(option => option.id !== null))) {
    return res.status(400).json({ error: "I nuovi gruppi opzioni non possono avere id preesistenti" });
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

  const create = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO products (name, price_cents, category, sort_order, active, stock, cost_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(n, price_cents, nextCategory, sort_order, nextActive, nextStock.stock, nextCost.cost);
    const productId = Number(info.lastInsertRowid);
    if (nextOptions.groups) replaceProductOptions(productId, nextOptions.groups);
    return productId;
  });
  const productId = create();

  res.json({ id: productId });
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
  const nextOptions = normalizeOptionGroups(req.body?.option_groups);

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
  if (!nextOptions.ok) return res.status(400).json({ error: nextOptions.error });
  if (nextOptions.groups && !optionIdsBelongToProduct(id, nextOptions.groups)) {
    return res.status(400).json({ error: "Gruppi o scelte non associati al prodotto" });
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

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE products
      SET name=?, price_cents=?, category=?, sort_order=?, active=?, sold_out=?, stock=?, cost_cents=?
      WHERE id=?
    `).run(nextName, nextPrice, nextCategory, nextSort, nextActive, nextSoldOut,
      nextStock.stock, nextCost.cost, id);
    if (nextOptions.groups) replaceProductOptions(id, nextOptions.groups);
  });
  update();

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
