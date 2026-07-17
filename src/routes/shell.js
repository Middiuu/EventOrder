const express = require("express");
const { db } = require("../db");

const router = express.Router();

// Riepilogo minimale per i badge di navigazione. Evita di trasferire interi
// cataloghi e centinaia di vendite (con relative righe) per mostrare due numeri.
router.get("/summary", (req, res) => {
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM products WHERE active = 1) AS active_products,
      (SELECT COUNT(*) FROM sales WHERE voided = 0) AS valid_sales
  `).get();

  res.json(counts);
});

module.exports = router;
