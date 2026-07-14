const MAX_MONEY_CENTS = 1_000_000_000_000;
const MAX_PRODUCT_PRICE_CENTS = 100_000_000;
const MAX_QTY = 9_999;
const MAX_SORT_ORDER = 1_000_000_000;
const MAX_STOCK = 1_000_000;

function isSafeIntegerInRange(value, min, max) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= min
    && value <= max;
}

function isValidCents(value, max = MAX_MONEY_CENTS) {
  return isSafeIntegerInRange(value, 0, max);
}

function normalizeActive(value, fallback) {
  if (value === undefined) return fallback ? 1 : 0;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return null;
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maxLength) return null;
  return text;
}

module.exports = {
  MAX_MONEY_CENTS,
  MAX_PRODUCT_PRICE_CENTS,
  MAX_QTY,
  MAX_SORT_ORDER,
  MAX_STOCK,
  cleanText,
  isSafeIntegerInRange,
  isValidCents,
  normalizeActive,
};
