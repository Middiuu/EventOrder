const express = require("express");
const { db } = require("../db");
const { config } = require("../config");
const {
  allocateNetByItem,
  createReportService,
  salesScopeFromQuery,
} = require("../reporting/service");
const { csvEscape, csvText, centsToEuroString } = require("../reporting/csv");
const databaseMaintenance = require("./database-maintenance");

const router = express.Router();
const reportService = createReportService(db);

function scopeLabel(scope) {
  return scope.sessionId ? `turno-${scope.sessionId}` : `${scope.fromDay}_to_${scope.toDay}`;
}

function sendCsv(res, filename, lines) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("\uFEFF" + lines.join("\n"));
}

router.get("/summary", (req, res) => {
  const scope = salesScopeFromQuery(req.query);
  res.json({
    ...reportService.buildSummary(scope),
    fromDay: scope.fromDay ?? null,
    toDay: scope.toDay ?? null,
    session: scope.sessionId ?? null,
  });
});

router.get("/today", (req, res) => {
  res.json(reportService.buildSummary(salesScopeFromQuery({})));
});

router.get("/export.csv", (req, res) => {
  const scope = salesScopeFromQuery(req.query);
  const { summary, byProduct } = reportService.buildSummary(scope);
  const separator = ";";
  const lines = [[
    "from",
    "to_exclusive",
    "sales_count",
    "total_revenue_eur",
    "product_name",
    "qty_sold",
    "product_gross_revenue_eur",
    "product_net_revenue_eur",
    "product_margin_eur",
    "product_margin_complete",
  ].join(separator)];
  const fromLabel = scope.fromDay || `turno-${scope.sessionId}`;
  const toLabel = scope.toDay || "";

  if (byProduct.length === 0) {
    lines.push([
      fromLabel,
      toLabel,
      String(summary.sales_count),
      centsToEuroString(summary.revenue_cents),
      "",
      "0",
      "0,00",
      "0,00",
      "",
      "",
    ].map(csvEscape).join(separator));
  } else {
    for (const product of byProduct) {
      lines.push([
        fromLabel,
        toLabel,
        String(summary.sales_count),
        centsToEuroString(summary.revenue_cents),
        csvText(product.name),
        String(product.qty_sold),
        centsToEuroString(product.gross_revenue_cents),
        centsToEuroString(product.net_revenue_cents),
        product.margin_cents === null ? "" : centsToEuroString(product.margin_cents),
        product.margin_cents === null ? "" : (product.margin_complete ? "1" : "0"),
      ].map(csvEscape).join(separator));
    }
  }

  sendCsv(res, `${config.SLUG}_${scopeLabel(scope)}.csv`, lines);
});

router.get("/items.csv", (req, res) => {
  const scope = salesScopeFromQuery(req.query);
  const { sales, itemsBySale } = reportService.loadScopedSales(
    scope,
    { includeVoided: true }
  );
  const separator = ";";
  const lines = [[
    "sale_number",
    "datetime",
    "operator",
    "session_id",
    "payment_method",
    "voided",
    "product_name",
    "category",
    "options",
    "item_note",
    "order_note",
    "qty",
    "unit_price_eur",
    "line_gross_eur",
    "line_discount_eur",
    "line_net_eur",
    "line_cost_eur",
  ].join(separator)];

  for (const sale of sales) {
    const items = itemsBySale.get(sale.id) || [];
    const net = allocateNetByItem(sale, items);
    for (const item of items) {
      const netCents = net.get(item.id) || 0;
      let options = "";
      try {
        options = JSON.parse(item.options_json || "[]")
          .map(option => `${option.group_name}: ${option.name}`)
          .join(" | ");
      } catch {}
      lines.push([
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
      ].map(csvEscape).join(separator));
    }
  }

  sendCsv(res, `${config.SLUG}_righe_${scopeLabel(scope)}.csv`, lines);
});

router.get("/transactions.csv", (req, res) => {
  const scope = salesScopeFromQuery(req.query);
  const rows = reportService.loadTransactions(scope);
  const separator = ";";
  const lines = [[
    "sale_number",
    "datetime",
    "operator",
    "payment_method",
    "discount_eur",
    "total_eur",
    "voided",
    "session_id",
    "order_note",
  ].join(separator)];

  for (const sale of rows) {
    lines.push([
      String(sale.sale_number),
      sale.created_local || "",
      csvText(sale.operator),
      sale.payment_method || "",
      centsToEuroString(sale.discount_cents),
      centsToEuroString(sale.total_cents),
      sale.voided ? "1" : "0",
      sale.session_id == null ? "" : String(sale.session_id),
      csvText(sale.note),
    ].map(csvEscape).join(separator));
  }

  sendCsv(res, `${config.SLUG}_transazioni_${scopeLabel(scope)}.csv`, lines);
});

router.use(databaseMaintenance);

module.exports = router;
