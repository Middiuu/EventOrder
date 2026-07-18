const crypto = require("crypto");
const {
  MAX_PRODUCT_PRICE_CENTS,
  MAX_STOCK,
  cleanText,
  isSafeIntegerInRange,
  isValidCents,
  normalizeActive,
} = require("../validation");

const MAX_OPTION_GROUPS = 10;
const MAX_OPTION_VALUES = 20;

function cleanName(name) {
  return cleanText(name, 120);
}

function normalizeStock(value, fallback) {
  if (value === undefined) return { ok: true, stock: fallback };
  if (value === null || value === "") return { ok: true, stock: null };
  if (isSafeIntegerInRange(value, 0, MAX_STOCK)) return { ok: true, stock: value };
  return { ok: false };
}

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
    const selectionType = raw.selection_type === "multiple"
      ? "multiple"
      : raw.selection_type === "single" ? "single" : null;
    const required = normalizeActive(raw.required, false);
    const options = Array.isArray(raw.options) ? raw.options : null;
    if ((groupId !== null && (!Number.isSafeInteger(groupId) || groupId <= 0))
      || !name || !selectionType || required === null || !options
      || options.length === 0 || options.length > MAX_OPTION_VALUES) {
      return { ok: false, error: `Gruppo opzioni ${groupIndex + 1} non valido` };
    }
    const normalizedOptions = [];
    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      const option = options[optionIndex] || {};
      const optionId = option.id === undefined ? null : option.id;
      const optionName = cleanText(option.name, 80);
      const delta = option.price_delta_cents ?? 0;
      if ((optionId !== null && (!Number.isSafeInteger(optionId) || optionId <= 0))
        || !optionName
        || !isSafeIntegerInRange(delta, -MAX_PRODUCT_PRICE_CENTS, MAX_PRODUCT_PRICE_CENTS)) {
        return { ok: false, error: `Opzione ${optionIndex + 1} del gruppo ${name} non valida` };
      }
      normalizedOptions.push({
        id: optionId,
        name: optionName,
        price_delta_cents: delta,
        sort_order: optionIndex * 10,
      });
    }
    const names = normalizedOptions.map(option => option.name.toLocaleLowerCase("it-IT"));
    if (new Set(names).size !== names.length) {
      return { ok: false, error: `Il gruppo ${name} contiene opzioni duplicate` };
    }
    groups.push({
      id: groupId,
      name,
      selection_type: selectionType,
      required,
      sort_order: groupIndex * 10,
      options: normalizedOptions,
    });
  }
  const groupNames = groups.map(group => group.name.toLocaleLowerCase("it-IT"));
  if (new Set(groupNames).size !== groupNames.length) {
    return { ok: false, error: "I gruppi di opzioni devono avere nomi diversi" };
  }
  return { ok: true, groups };
}

function replaceProductOptions(database, productId, groups) {
  const temporaryPrefix = `__eo_${crypto.randomUUID()}_`;
  database.prepare(`
    UPDATE product_option_values
    SET name = ? || id
    WHERE group_id IN (SELECT id FROM product_option_groups WHERE product_id = ?)
  `).run(temporaryPrefix, productId);
  database.prepare(`
    UPDATE product_option_groups SET name = ? || id WHERE product_id = ?
  `).run(temporaryPrefix, productId);

  const insertGroup = database.prepare(`
    INSERT INTO product_option_groups (product_id, name, selection_type, required, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertOption = database.prepare(`
    INSERT INTO product_option_values (group_id, name, price_delta_cents, sort_order)
    VALUES (?, ?, ?, ?)
  `);
  const updateGroup = database.prepare(`
    UPDATE product_option_groups
    SET name=?, selection_type=?, required=?, sort_order=?, active=1
    WHERE id=? AND product_id=?
  `);
  const updateOption = database.prepare(`
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
    database.prepare(`DELETE FROM product_option_values WHERE group_id=? AND id NOT IN (${optionPlaceholders})`)
      .run(groupId, ...keptOptionIds);
  }
  if (keptGroupIds.length === 0) {
    database.prepare("DELETE FROM product_option_groups WHERE product_id=?").run(productId);
  } else {
    const groupPlaceholders = keptGroupIds.map(() => "?").join(",");
    database.prepare(`DELETE FROM product_option_groups WHERE product_id=? AND id NOT IN (${groupPlaceholders})`)
      .run(productId, ...keptGroupIds);
  }
}

function optionIdsBelongToProduct(database, productId, groups) {
  for (const group of groups) {
    if (group.id !== null) {
      const found = database.prepare(
        "SELECT 1 FROM product_option_groups WHERE id=? AND product_id=?"
      ).get(group.id, productId);
      if (!found) return false;
    }
    for (const option of group.options) {
      if (option.id !== null) {
        if (group.id === null) return false;
        const found = database.prepare(`
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

function withProductOptions(database, rows, { activeOnly = false } = {}) {
  if (rows.length === 0) return rows;
  const ids = rows.map(row => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const activeSql = activeOnly ? "AND g.active=1 AND v.active=1" : "";
  const options = database.prepare(`
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

module.exports = {
  cleanName,
  normalizeCost,
  normalizeOptionGroups,
  normalizeStock,
  optionIdsBelongToProduct,
  replaceProductOptions,
  withProductOptions,
};
