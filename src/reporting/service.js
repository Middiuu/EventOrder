const { localYmdToUtcSql, parseLocalYmd } = require("../validation");
const queries = require("./queries");

function pad2(number) {
  return String(number).padStart(2, "0");
}

function formatLocalDateYYYYMMDD(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function rangeError(message) {
  const error = new Error(message);
  error.status = 400;
  error.publicMessage = message;
  return error;
}

function getRangeFromQuery(query) {
  const today = formatLocalDateYYYYMMDD();
  const fromDay = String(query.from || today).trim();
  const fromDate = parseLocalYmd(fromDay);
  if (!fromDate) throw rangeError("Data 'from' non valida: usa YYYY-MM-DD");

  const autoTo = formatLocalDateYYYYMMDD(addDays(fromDate, 1));
  const toDay = String(query.to || autoTo).trim();
  const toDate = parseLocalYmd(toDay);
  if (!toDate) throw rangeError("Data 'to' non valida: usa YYYY-MM-DD");
  if (toDate <= fromDate) throw rangeError("La data 'to' deve essere successiva a 'from'");

  return {
    fromDay,
    toDay,
    from: localYmdToUtcSql(fromDay),
    to: localYmdToUtcSql(toDay),
  };
}

function salesScopeFromQuery(query) {
  if (query.session !== undefined) {
    const sessionId = Number(query.session);
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      throw rangeError("Turno non valido");
    }
    return { where: "s.session_id = ?", params: [sessionId], sessionId };
  }
  const { fromDay, toDay, from, to } = getRangeFromQuery(query);
  return {
    where: "s.created_at >= ? AND s.created_at < ?",
    params: [from, to],
    fromDay,
    toDay,
  };
}

// Metodo dei resti maggiori con aritmetica intera: evita perdita di precisione
// nella moltiplicazione line_total_cents * total_cents.
function allocateNetByItem(sale, items) {
  const net = new Map();
  const subtotal = items.reduce((sum, item) => sum + item.line_total_cents, 0);
  if (!sale.discount_cents || subtotal <= 0) {
    for (const item of items) net.set(item.id, item.line_total_cents);
    return net;
  }

  const denominator = BigInt(subtotal);
  const target = BigInt(sale.total_cents);
  const shares = items.map((item, index) => {
    const numerator = BigInt(item.line_total_cents) * target;
    return {
      id: item.id,
      index,
      floor: numerator / denominator,
      fraction: numerator % denominator,
    };
  });
  let remainder = target - shares.reduce((sum, share) => sum + share.floor, 0n);
  shares.sort((left, right) => {
    if (left.fraction === right.fraction) return left.index - right.index;
    return left.fraction > right.fraction ? -1 : 1;
  });
  for (const share of shares) {
    const extra = remainder > 0n ? 1n : 0n;
    net.set(share.id, Number(share.floor + extra));
    remainder -= extra;
  }
  return net;
}

function productBreakdown(sales, itemsBySale) {
  const aggregate = new Map();
  for (const sale of sales) {
    const items = itemsBySale.get(sale.id) || [];
    const net = allocateNetByItem(sale, items);
    for (const item of items) {
      const identity = JSON.stringify([item.product_id, item.product_name, item.product_category]);
      const row = aggregate.get(identity) || {
        product_id: item.product_id,
        name: item.product_name,
        category: item.product_category,
        qty_sold: 0,
        gross_revenue_cents: 0,
        net_revenue_cents: 0,
        tracked_net_revenue_cents: 0,
        cost_cents: 0,
        tracked_items: 0,
        untracked_items: 0,
      };
      row.qty_sold += item.qty;
      row.gross_revenue_cents += item.line_total_cents;
      row.net_revenue_cents += net.get(item.id) || 0;
      if (item.product_cost_cents == null) {
        row.untracked_items += 1;
      } else {
        row.tracked_items += 1;
        row.tracked_net_revenue_cents += net.get(item.id) || 0;
        row.cost_cents += item.product_cost_cents * item.qty;
      }
      aggregate.set(identity, row);
    }
  }
  return [...aggregate.values()]
    .map(row => ({
      ...row,
      revenue_cents: row.gross_revenue_cents,
      cost_tracked: row.untracked_items === 0,
      margin_complete: row.untracked_items === 0,
      margin_cents: row.tracked_items > 0
        ? row.tracked_net_revenue_cents - row.cost_cents
        : null,
    }))
    .sort((left, right) => (
      right.qty_sold - left.qty_sold || right.net_revenue_cents - left.net_revenue_cents
    ));
}

function createReportService(database) {
  if (!database) throw new TypeError("createReportService richiede una connessione database");
  function loadScopedSales(scope, options) {
    return queries.loadScopedSales(database, scope, options);
  }

  function buildSummary(scope) {
    const { sales, itemsBySale } = loadScopedSales(scope);
    const byProduct = productBreakdown(sales, itemsBySale);
    const trackedProducts = byProduct.filter(product => product.margin_cents !== null);
    const trackedRevenueCents = byProduct.reduce(
      (sum, product) => sum + product.tracked_net_revenue_cents,
      0
    );
    const totalRevenueCents = sales.reduce((sum, sale) => sum + sale.total_cents, 0);
    const marginComplete = byProduct.length > 0
      && byProduct.every(product => product.margin_complete);

    const summary = {
      sales_count: sales.length,
      revenue_cents: totalRevenueCents,
      discount_cents: sales.reduce((sum, sale) => sum + sale.discount_cents, 0),
      margin_cents: trackedProducts.length
        ? trackedProducts.reduce((sum, product) => sum + product.margin_cents, 0)
        : null,
      margin_products: trackedProducts.length,
      margin_total_products: byProduct.length,
      margin_complete: marginComplete,
      margin_tracked_revenue_cents: trackedRevenueCents,
      margin_coverage_percent: totalRevenueCents > 0
        ? Math.round(trackedRevenueCents / totalRevenueCents * 100)
        : (marginComplete ? 100 : 0),
    };

    const payment = new Map();
    const hours = new Map();
    const days = new Map();
    for (const sale of sales) {
      const pay = payment.get(sale.payment_method) || {
        payment_method: sale.payment_method,
        count: 0,
        revenue_cents: 0,
      };
      pay.count += 1;
      pay.revenue_cents += sale.total_cents;
      payment.set(sale.payment_method, pay);

      const hour = Number(sale.created_local.slice(11, 13));
      hours.set(hour, (hours.get(hour) || 0) + sale.total_cents);

      const day = sale.created_local.slice(0, 10);
      const dayRow = days.get(day) || { day, sales_count: 0, revenue_cents: 0 };
      dayRow.sales_count += 1;
      dayRow.revenue_cents += sale.total_cents;
      days.set(day, dayRow);
    }

    return {
      summary,
      byProduct,
      byPayment: [...payment.values()].sort((a, b) => b.revenue_cents - a.revenue_cents),
      byHour: [...hours.entries()]
        .map(([hour, revenue_cents]) => ({ hour, revenue_cents }))
        .sort((a, b) => a.hour - b.hour),
      byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    };
  }

  return {
    buildSummary,
    loadScopedSales,
    loadTransactions: scope => queries.loadTransactions(database, scope),
  };
}

module.exports = {
  allocateNetByItem,
  createReportService,
  salesScopeFromQuery,
};
