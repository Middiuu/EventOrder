const { db } = require("./db");

function loadOptionCatalog(productIds) {
  const uniqueIds = [...new Set(productIds)];
  if (uniqueIds.length === 0) return new Map();
  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT g.id AS group_id, g.product_id, g.name AS group_name,
           g.selection_type, g.required, v.id AS value_id, v.name,
           v.price_delta_cents
    FROM product_option_groups g
    JOIN product_option_values v ON v.group_id = g.id
    WHERE g.active=1 AND v.active=1 AND g.product_id IN (${placeholders})
    ORDER BY g.product_id, g.sort_order, g.id, v.sort_order, v.id
  `).all(...uniqueIds);
  const byProduct = new Map(uniqueIds.map(id => [id, []]));
  for (const row of rows) {
    const groups = byProduct.get(row.product_id);
    let group = groups.find(candidate => candidate.id === row.group_id);
    if (!group) {
      group = { id: row.group_id, name: row.group_name, selection_type: row.selection_type,
        required: row.required, values: [] };
      groups.push(group);
    }
    group.values.push({ id: row.value_id, name: row.name, price_delta_cents: row.price_delta_cents });
  }
  return byProduct;
}

function resolveSelectedOptions(item, groups) {
  const selectedIds = item.selected_option_value_ids;
  const selectedSet = new Set(selectedIds);
  const knownIds = new Set(groups.flatMap(group => group.values.map(value => value.id)));
  if (selectedIds.some(id => !knownIds.has(id))) {
    return { error: "La comanda contiene un'opzione non valida o non piu' disponibile" };
  }
  const selected = [];
  for (const group of groups) {
    const values = group.values.filter(value => selectedSet.has(value.id));
    if (group.required && values.length === 0) return { error: `Scegli almeno un'opzione per ${group.name}` };
    if (group.selection_type === "single" && values.length > 1) {
      return { error: `Puoi scegliere una sola opzione per ${group.name}` };
    }
    for (const value of values) {
      selected.push({ group_id: group.id, group_name: group.name, value_id: value.id,
        name: value.name, price_delta_cents: value.price_delta_cents });
    }
  }
  return { selected };
}

module.exports = { loadOptionCatalog, resolveSelectedOptions };
