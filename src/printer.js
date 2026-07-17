const { config } = require("./config");

function formatMoney(cents) {
  const v = (cents / 100).toFixed(2).replace(".", ",");
  return `${config.CURRENCY_SYMBOL} ${v}`;
}

const PAYMENT_LABEL = { cash: "Contanti", card: "Carta", other: "Altro" };

function discountLabel(discountType, discountValue) {
  if (discountType === "gift") return "Omaggio";
  if (discountType === "percent") return `Sconto ${discountValue}%`;
  if (discountType === "amount") return "Sconto";
  return "Sconto";
}

function parseSqliteUtc(value) {
  if (value instanceof Date) return value;
  const text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return new Date(text.replace(" ", "T") + "Z");
  }
  return new Date(text);
}

function buildTicketText({ saleNumber, createdAt, items, subtotalCents, discountCents, discountType, discountValue, totalCents, paymentMethod, cashReceivedCents, changeCents, operator, orderNote }) {
  const lines = [];
  lines.push(config.BUSINESS_NAME.toUpperCase());
  lines.push(parseSqliteUtc(createdAt).toLocaleString(config.LOCALE));
  lines.push(`TICKET #${String(saleNumber).padStart(4, "0")}`);
  if (operator) lines.push(`Operatore: ${operator}`);
  lines.push("--------------------------");

  for (const it of items) {
    const qty = `${it.qty}x`.padEnd(3);
    lines.push(`${qty} ${it.name}`);
    for (const option of it.options || []) {
      const delta = option.price_delta_cents
        ? ` (${option.price_delta_cents > 0 ? "+" : ""}${formatMoney(option.price_delta_cents)})`
        : "";
      lines.push(`    ${option.group_name}: ${option.name}${delta}`);
    }
    if (it.note) lines.push(`    Nota: ${it.note}`);
  }

  if (orderNote) {
    lines.push("");
    lines.push(`NOTA: ${orderNote}`);
  }

  lines.push("--------------------------");
  if (discountCents > 0) {
    lines.push(`Subtotale: ${formatMoney(subtotalCents)}`);
    lines.push(`${discountLabel(discountType, discountValue)}: -${formatMoney(discountCents)}`);
  }
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

module.exports = { buildTicketText, printTicket };
