/* exported EventOrderPayment */
(function attachPaymentModel(root) {
  const PAYMENT_METHODS = new Set(["cash", "card", "other"]);
  const DISCOUNT_TYPES = new Set(["none", "percent", "amount", "gift"]);

  function createPaymentModel(parseCents) {
    if (typeof parseCents !== "function") throw new TypeError("parseCents obbligatorio");

    let paymentMethod = "cash";
    let discountType = "none";
    let discountValue = "";
    let cashReceivedValue = "";

    function requireSubtotal(value) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("Subtotale non valido");
      }
      return value;
    }

    function percentage() {
      return Number(String(discountValue).replace(",", "."));
    }

    function discountCents(subtotalValue) {
      const subtotal = requireSubtotal(subtotalValue);
      if (discountType === "gift") return subtotal;
      if (discountType === "percent") {
        const value = percentage();
        if (!Number.isFinite(value) || value <= 0) return 0;
        return Math.round(subtotal * Math.min(value, 100) / 100);
      }
      if (discountType === "amount") {
        const value = parseCents(discountValue);
        return value === null ? 0 : Math.min(value, subtotal);
      }
      return 0;
    }

    function payableTotal(subtotal) {
      return requireSubtotal(subtotal) - discountCents(subtotal);
    }

    function discountBody() {
      if (discountType === "none") return undefined;
      if (discountType === "gift") return { type: "gift" };
      if (discountType === "percent") return { type: "percent", value: percentage() || 0 };
      return { type: "amount", value: parseCents(discountValue) || 0 };
    }

    function quickCashValues(totalValue) {
      const total = requireSubtotal(totalValue);
      const values = new Set([total]);
      for (const step of [500, 1000, 2000, 5000, 10000]) {
        values.add(Math.ceil(total / step) * step);
      }
      return [...values]
        .filter(value => value >= total && value > 0)
        .sort((a, b) => a - b)
        .slice(0, 5);
    }

    function cashState(subtotal) {
      const total = payableTotal(subtotal);
      if (paymentMethod !== "cash" || total <= 0) {
        return { canConfirm: true, receivedCents: total <= 0 ? 0 : null, changeCents: 0 };
      }
      const receivedCents = parseCents(cashReceivedValue);
      if (receivedCents === null || receivedCents < total) {
        return { canConfirm: false, receivedCents, changeCents: null };
      }
      return { canConfirm: true, receivedCents, changeCents: receivedCents - total };
    }

    function validateDiscount() {
      if (discountType !== "percent") return null;
      const value = percentage();
      return Number.isFinite(value) && value >= 0 && value <= 100
        ? null
        : "Percentuale sconto non valida (0-100).";
    }

    function buildAttempt({ items, note, subtotalCents, requestId }) {
      const discountError = validateDiscount();
      if (discountError) return { error: discountError };
      const payment = cashState(subtotalCents);
      if (!payment.canConfirm) return { error: "Contanti ricevuti insufficienti." };

      const body = {
        items: Array.from(items).map(item => ({
          product_id: item.product.id,
          qty: item.qty,
          expected_unit_price_cents: item.unit_price_cents,
          selected_option_value_ids: item.selected_option_value_ids,
          note: item.note,
        })),
        note: String(note || "").trim() || null,
        payment_method: paymentMethod,
        discount: discountBody(),
      };
      if (paymentMethod === "cash") body.cash_received_cents = payment.receivedCents;
      return {
        attempt: { requestId, payload: JSON.stringify(body) },
        totalCents: payableTotal(subtotalCents),
      };
    }

    function restoreAttempt(payload) {
      try {
        const body = JSON.parse(payload);
        paymentMethod = PAYMENT_METHODS.has(body.payment_method) ? body.payment_method : "cash";
        discountType = DISCOUNT_TYPES.has(body.discount?.type) ? body.discount.type : "none";
        discountValue = discountType === "amount"
          ? (Number(body.discount?.value || 0) / 100).toFixed(2)
          : (discountType === "percent" ? String(body.discount?.value ?? "") : "");
        cashReceivedValue = body.cash_received_cents == null
          ? ""
          : (Number(body.cash_received_cents) / 100).toFixed(2);
        return true;
      } catch {
        return false;
      }
    }

    return Object.freeze({
      get paymentMethod() { return paymentMethod; },
      get discountType() { return discountType; },
      get discountValue() { return discountValue; },
      get cashReceivedValue() { return cashReceivedValue; },
      setPaymentMethod(value) { paymentMethod = PAYMENT_METHODS.has(value) ? value : "cash"; },
      setDiscount(type) {
        discountType = DISCOUNT_TYPES.has(type) ? type : "none";
        discountValue = "";
      },
      setDiscountValue(value) { discountValue = String(value ?? ""); },
      setCashReceivedValue(value) { cashReceivedValue = String(value ?? ""); },
      buildAttempt,
      cashState,
      discountBody,
      discountCents,
      payableTotal,
      quickCashValues,
      restoreAttempt,
    });
  }

  root.EventOrderPayment = Object.freeze({ createPaymentModel });
})(globalThis);
