const { config } = require("./config");

function formatMoney(cents) {
  const v = (cents / 100).toFixed(2).replace(".", ",");
  return `${config.CURRENCY_SYMBOL} ${v}`;
}

const PAYMENT_LABEL = { cash: "Contanti", card: "Carta", other: "Altro" };

function buildTicketText({ saleNumber, createdAt, items, totalCents, paymentMethod, cashReceivedCents, changeCents, operator }) {
  const lines = [];
  lines.push(config.BUSINESS_NAME.toUpperCase());
  lines.push(new Date(createdAt).toLocaleString(config.LOCALE));
  lines.push(`TICKET #${String(saleNumber).padStart(4, "0")}`);
  if (operator) lines.push(`Operatore: ${operator}`);
  lines.push("--------------------------");

  for (const it of items) {
    const qty = `${it.qty}x`.padEnd(3);
    lines.push(`${qty} ${it.name}`);
  }

  lines.push("--------------------------");
  lines.push(`Totale: ${formatMoney(totalCents)}`);

  if (paymentMethod) {
    lines.push(`Pagamento: ${PAYMENT_LABEL[paymentMethod] || paymentMethod}`);
  }
  if (paymentMethod === "cash" && cashReceivedCents != null) {
    lines.push(`Contanti: ${formatMoney(cashReceivedCents)}`);
    lines.push(`Resto: ${formatMoney(changeCents || 0)}`);
  }

  lines.push("");
  lines.push("Documento non fiscale");
  lines.push("");
  return lines.join("\n");
}

// Per ora stampa su console (stub).
// Quando scegli la stampante, qui invieremo ESC/POS via USB/LAN.
async function printTicket(payload) {
  const text = buildTicketText(payload);
  console.log("\n=== PRINT TICKET (STUB) ===\n" + text + "\n==========================\n");
}

module.exports = { printTicket };