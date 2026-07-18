const { loadSaleItems } = require("./items");

function printableError(error) {
  const message = String(error?.message || error || "Errore stampante")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return (message || "Errore stampante").slice(0, 500);
}

function createSalesPrinting({
  database,
  printTicket,
  markSalePending,
  unmarkSalePending,
}) {
  function beginPrintAttempt(saleId) {
    database.prepare(`
      UPDATE sales
      SET print_status='pending', print_attempts=print_attempts+1,
          last_print_error=NULL, last_print_attempt_at=datetime('now')
      WHERE id=? AND voided=0
    `).run(saleId);
  }

  function completePrintAttempt(saleId) {
    database.prepare(`
      UPDATE sales
      SET print_status='printed', last_print_error=NULL,
          last_printed_at=datetime('now')
      WHERE id=? AND voided=0
    `).run(saleId);
  }

  function failPrintAttempt(saleId, message) {
    database.prepare(`
      UPDATE sales
      SET print_status='failed', last_print_error=?
      WHERE id=? AND voided=0
    `).run(message, saleId);
  }

  function printState(saleId) {
    return database.prepare(`
      SELECT print_status, print_attempts, last_print_error,
             last_print_attempt_at, last_printed_at
      FROM sales WHERE id=?
    `).get(saleId);
  }

  async function attempt(saleId, sessionId, payload) {
    markSalePending(saleId, sessionId);
    try {
      beginPrintAttempt(saleId);
      await printTicket(payload);
      completePrintAttempt(saleId);
      return { ok: true, state: printState(saleId) };
    } catch (error) {
      const message = printableError(error);
      console.error(`Stampa vendita #${payload.saleNumber} non riuscita: ${message}`);
      failPrintAttempt(saleId, message);
      return { ok: false, message, state: printState(saleId) };
    } finally {
      unmarkSalePending(saleId);
    }
  }

  function loadPayload(saleId) {
    const sale = database.prepare(`
      SELECT id, sale_number, created_at, total_cents, discount_cents,
             discount_type, discount_value, payment_method,
             cash_received_cents, change_cents, operator, session_id, note, voided
      FROM sales WHERE id=?
    `).get(saleId);
    if (!sale) return null;
    const items = loadSaleItems(database, [saleId]).get(saleId) || [];
    return {
      sale,
      payload: {
        saleNumber: sale.sale_number,
        createdAt: sale.created_at,
        items,
        subtotalCents: sale.total_cents + sale.discount_cents,
        discountCents: sale.discount_cents,
        discountType: sale.discount_type,
        discountValue: sale.discount_value,
        totalCents: sale.total_cents,
        paymentMethod: sale.payment_method,
        cashReceivedCents: sale.cash_received_cents,
        changeCents: sale.change_cents,
        operator: sale.operator,
        orderNote: sale.note,
      },
    };
  }

  return { attempt, loadPayload };
}

module.exports = { createSalesPrinting, printableError };
