const express = require("express");
const { db, DB_PATH } = require("../db");
const { config } = require("../config");
const fs = require("fs");
const path = require("path");

const router = express.Router();

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatLocalDateYYYYMMDD(d = new Date()) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

function addDays(dateObj, days) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + days);
  return d;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",;\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function centsToEuroString(cents) {
  return (Number(cents) / 100).toFixed(2).replace(".", ",");
}

/**
 * Ritorna range [from,to) in local time.
 * Query:
 *  - from=YYYY-MM-DD (default: oggi)
 *  - to=YYYY-MM-DD   (default: domani)  <-- to è esclusivo
 */
function getRangeFromQuery(req) {
  const today = formatLocalDateYYYYMMDD(new Date());
  const fromDay = String(req.query.from || today).trim();

  // default: from + 1 giorno
  const autoTo = formatLocalDateYYYYMMDD(addDays(new Date(fromDay), 1));
  const toDay = String(req.query.to || autoTo).trim();

  const from = `${fromDay} 00:00:00`;
  const to = `${toDay} 00:00:00`;

  return { fromDay, toDay, from, to };
}

// --- JSON report "oggi"
router.get("/today", (req, res) => {
  // created_at e' salvato in UTC: va convertito in ora locale prima di
  // confrontarlo con la data odierna locale, altrimenti le vendite a cavallo
  // della mezzanotte (es. eventi serali) finiscono nel giorno sbagliato.
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS sales_count,
      COALESCE(SUM(total_cents), 0) AS revenue_cents
    FROM sales
    WHERE voided=0 AND date(created_at,'localtime')=date('now','localtime')
  `).get();

  const byProduct = db.prepare(`
    SELECT
      p.name,
      SUM(si.qty) AS qty_sold,
      SUM(si.line_total_cents) AS revenue_cents
    FROM sale_items si
    JOIN sales s ON s.id=si.sale_id
    JOIN products p ON p.id=si.product_id
    WHERE s.voided=0 AND date(s.created_at,'localtime')=date('now','localtime')
    GROUP BY p.id
    ORDER BY qty_sold DESC, revenue_cents DESC
  `).all();

  const byPayment = db.prepare(`
    SELECT
      payment_method,
      COUNT(*) AS count,
      COALESCE(SUM(total_cents), 0) AS revenue_cents
    FROM sales
    WHERE voided=0 AND date(created_at,'localtime')=date('now','localtime')
    GROUP BY payment_method
    ORDER BY revenue_cents DESC
  `).all();

  res.json({ summary, byProduct, byPayment });
});

// --- CSV export (Excel-friendly, separatore ';', BOM UTF-8)
router.get("/export.csv", (req, res) => {
  const { fromDay, toDay, from, to } = getRangeFromQuery(req);

  const byProduct = db.prepare(`
    SELECT
      p.name AS product_name,
      SUM(si.qty) AS qty_sold,
      SUM(si.line_total_cents) AS revenue_cents
    FROM sale_items si
    JOIN sales s ON s.id=si.sale_id
    JOIN products p ON p.id=si.product_id
    WHERE s.voided=0
      AND datetime(s.created_at,'localtime') >= datetime(?)
      AND datetime(s.created_at,'localtime') < datetime(?)
    GROUP BY p.id
    ORDER BY qty_sold DESC, revenue_cents DESC
  `).all(from, to);

  const total = db.prepare(`
    SELECT
      COALESCE(SUM(total_cents), 0) AS revenue_cents,
      COUNT(*) AS sales_count
    FROM sales s
    WHERE s.voided=0
      AND datetime(s.created_at,'localtime') >= datetime(?)
      AND datetime(s.created_at,'localtime') < datetime(?)
  `).get(from, to);

  const sep = ";";
  const header = [
    "from",
    "to_exclusive",
    "sales_count",
    "total_revenue_eur",
    "product_name",
    "qty_sold",
    "product_revenue_eur"
  ].join(sep);

  const lines = [header];

  if (byProduct.length === 0) {
    // comunque esporta una riga "vuota" con i totali
    lines.push([
      fromDay,
      toDay,
      String(total.sales_count),
      centsToEuroString(total.revenue_cents),
      "",
      "0",
      "0,00"
    ].map(csvEscape).join(sep));
  } else {
    for (const r of byProduct) {
      lines.push([
        fromDay,
        toDay,
        String(total.sales_count),
        centsToEuroString(total.revenue_cents),
        r.product_name,
        String(r.qty_sold),
        centsToEuroString(r.revenue_cents)
      ].map(csvEscape).join(sep));
    }
  }

  const filename = `${config.SLUG}_${fromDay}_to_${toDay}.csv`;

  // BOM per Excel (UTF-8)
  const bom = "\uFEFF";
  const csv = bom + lines.join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

// --- CSV export per-transazione (una riga per vendita, per contabilita')
router.get("/transactions.csv", (req, res) => {
  const { fromDay, toDay, from, to } = getRangeFromQuery(req);

  const rows = db.prepare(`
    SELECT
      sale_number,
      datetime(created_at, 'localtime') AS created_local,
      operator,
      payment_method,
      total_cents,
      voided,
      session_id
    FROM sales
    WHERE datetime(created_at, 'localtime') >= datetime(?)
      AND datetime(created_at, 'localtime') < datetime(?)
    ORDER BY sale_number ASC
  `).all(from, to);

  const sep = ";";
  const header = [
    "sale_number",
    "datetime",
    "operator",
    "payment_method",
    "total_eur",
    "voided",
    "session_id",
  ].join(sep);

  const lines = [header];
  for (const r of rows) {
    lines.push([
      String(r.sale_number),
      r.created_local || "",
      r.operator || "",
      r.payment_method || "",
      centsToEuroString(r.total_cents),
      r.voided ? "1" : "0",
      r.session_id == null ? "" : String(r.session_id),
    ].map(csvEscape).join(sep));
  }

  const filename = `${config.SLUG}_transazioni_${fromDay}_to_${toDay}.csv`;
  const csv = "﻿" + lines.join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

// --- Backup DB (copia consistente e download)
router.get("/backup", async (req, res, next) => {
  try {
    const projectRoot = path.dirname(DB_PATH);

    if (!fs.existsSync(DB_PATH)) {
      return res.status(404).json({ error: "Database non trovato" });
    }

    const backupsDir = path.join(projectRoot, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });

    const now = new Date();
    const stamp =
      `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-` +
      `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

    const backupName = `${config.SLUG}-backup-${stamp}.sqlite`;
    const backupPath = path.join(backupsDir, backupName);

    // Backup online: copia consistente anche mentre il DB e' in uso
    // (a differenza di copyFileSync, che puo' catturare uno stato parziale).
    await db.backup(backupPath);

    pruneBackups(backupsDir);

    res.setHeader("Content-Type", "application/x-sqlite3");
    res.setHeader("Content-Disposition", `attachment; filename="${backupName}"`);
    res.sendFile(backupPath);
  } catch (err) {
    next(err);
  }
});

// Rotazione: conserva solo i BACKUP_KEEP file piu' recenti (0 = illimitato)
function pruneBackups(backupsDir) {
  if (!config.BACKUP_KEEP) return;
  try {
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.endsWith(".sqlite"))
      .map(f => ({ f, t: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);

    for (const { f } of files.slice(config.BACKUP_KEEP)) {
      fs.rmSync(path.join(backupsDir, f), { force: true });
    }
  } catch {
    // la rotazione non deve mai far fallire il backup
  }
}

module.exports = router;
