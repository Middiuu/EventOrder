const express = require("express");
const { db } = require("../db");
const { config } = require("../config");
const {
  createReportService,
  salesScopeFromQuery,
} = require("../reporting/service");
const { csvEscape, csvText, centsToEuroString } = require("../reporting/csv");
const { streamItemsCsv, streamTransactionsCsv } = require("../reporting/exports");
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

router.get("/items.csv", async (req, res) => {
  const scope = salesScopeFromQuery(req.query);
  await streamItemsCsv(res, `${config.SLUG}_righe_${scopeLabel(scope)}.csv`, db, scope);
});

router.get("/transactions.csv", async (req, res) => {
  const scope = salesScopeFromQuery(req.query);
  await streamTransactionsCsv(
    res,
    `${config.SLUG}_transazioni_${scopeLabel(scope)}.csv`,
    db,
    scope
  );
});

router.use(databaseMaintenance);

module.exports = router;
