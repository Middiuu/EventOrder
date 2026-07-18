const { allocateNetByItem } = require("./service");
const { csvEscape, csvText, centsToEuroString } = require("./csv");
const { iterateScopedItems, iterateTransactions } = require("./queries");

const SEPARATOR = ";";

function csvRow(values) {
  return values.map(csvEscape).join(SEPARATOR);
}

function waitForDrainOrClose(res) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = writable => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      resolve(writable);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

async function writeChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) return false;
  return res.write(chunk) || waitForDrainOrClose(res);
}

async function streamCsv(res, filename, header, rows) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  if (!await writeChunk(res, `\uFEFF${header}\n`)) return;
  for (const row of rows) {
    if (!await writeChunk(res, `${row}\n`)) return;
  }
  res.end();
}

function transactionRows(database, scope) {
  const statement = iterateTransactions(database, scope);
  return (function* generate() {
    for (const sale of statement.iterate(...scope.params)) {
      yield csvRow([
        String(sale.sale_number),
        sale.created_local || "",
        csvText(sale.operator),
        sale.payment_method || "",
        centsToEuroString(sale.discount_cents),
        centsToEuroString(sale.total_cents),
        sale.voided ? "1" : "0",
        sale.session_id == null ? "" : String(sale.session_id),
        csvText(sale.note),
      ]);
    }
  })();
}

function saleFromRow(row) {
  return {
    id: row.sale_id,
    sale_number: row.sale_number,
    created_local: row.created_local,
    operator: row.operator,
    session_id: row.session_id,
    payment_method: row.payment_method,
    voided: row.voided,
    note: row.sale_note,
    total_cents: row.total_cents,
    discount_cents: row.discount_cents,
  };
}

function itemFromRow(row) {
  return {
    id: row.item_id,
    product_id: row.product_id,
    qty: row.qty,
    unit_price_cents: row.unit_price_cents,
    line_total_cents: row.line_total_cents,
    product_name: row.product_name,
    product_category: row.product_category,
    product_cost_cents: row.product_cost_cents,
    options_json: row.options_json,
    note: row.item_note,
  };
}

function itemRowsForSale(sale, items) {
  const net = allocateNetByItem(sale, items);
  return items.map(item => {
    const netCents = net.get(item.id) || 0;
    let options = "";
    try {
      options = JSON.parse(item.options_json || "[]")
        .map(option => `${option.group_name}: ${option.name}`)
        .join(" | ");
    } catch {}
    return csvRow([
      String(sale.sale_number),
      sale.created_local || "",
      csvText(sale.operator),
      sale.session_id == null ? "" : String(sale.session_id),
      sale.payment_method || "",
      sale.voided ? "1" : "0",
      csvText(item.product_name),
      csvText(item.product_category),
      csvText(options),
      csvText(item.note),
      csvText(sale.note),
      String(item.qty),
      centsToEuroString(item.unit_price_cents),
      centsToEuroString(item.line_total_cents),
      centsToEuroString(item.line_total_cents - netCents),
      centsToEuroString(netCents),
      item.product_cost_cents == null
        ? ""
        : centsToEuroString(item.product_cost_cents * item.qty),
    ]);
  });
}

function itemRows(database, scope) {
  const statement = iterateScopedItems(database, scope);
  return (function* generate() {
    let sale = null;
    let items = [];
    for (const row of statement.iterate(...scope.params)) {
      if (sale && sale.id !== row.sale_id) {
        yield* itemRowsForSale(sale, items);
        items = [];
      }
      if (!sale || sale.id !== row.sale_id) sale = saleFromRow(row);
      items.push(itemFromRow(row));
    }
    if (sale) yield* itemRowsForSale(sale, items);
  })();
}

const TRANSACTIONS_HEADER = [
  "sale_number", "datetime", "operator", "payment_method", "discount_eur",
  "total_eur", "voided", "session_id", "order_note",
].join(SEPARATOR);

const ITEMS_HEADER = [
  "sale_number", "datetime", "operator", "session_id", "payment_method", "voided",
  "product_name", "category", "options", "item_note", "order_note", "qty",
  "unit_price_eur", "line_gross_eur", "line_discount_eur", "line_net_eur", "line_cost_eur",
].join(SEPARATOR);

module.exports = {
  streamItemsCsv: (res, filename, database, scope) => (
    streamCsv(res, filename, ITEMS_HEADER, itemRows(database, scope))
  ),
  streamTransactionsCsv: (res, filename, database, scope) => (
    streamCsv(res, filename, TRANSACTIONS_HEADER, transactionRows(database, scope))
  ),
};
