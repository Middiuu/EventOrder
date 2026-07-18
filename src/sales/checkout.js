const {
  MAX_MONEY_CENTS,
  MAX_PRODUCT_PRICE_CENTS,
  MAX_QTY,
  cleanText,
  isValidCents,
} = require("../validation");
const { IDEMPOTENCY_KEY_RE, fingerprint } = require("../idempotency");
const { conflictError, responseError } = require("./errors");

function idempotencyFingerprint(sessionId, normalized, paymentMethod, body) {
  const discount = body?.discount && body.discount.type
    ? { type: String(body.discount.type), value: body.discount.value ?? null }
    : null;
  return fingerprint({
    session_id: sessionId,
    items: normalized,
    payment_method: paymentMethod,
    cash_received_cents: body?.cash_received_cents ?? null,
    note: body?.note ?? null,
    discount,
  });
}

function fail(status, body) {
  throw responseError(status, typeof body === "string" ? { error: body } : body);
}

function createCheckoutService({
  database,
  getNextSaleNumber,
  getOpenSession,
  isSalePending,
  loadOptionCatalog,
  resolveSelectedOptions,
  paymentMethods,
}) {
  function replayExistingSale(clientRequestId, requestFingerprint) {
    const sale = database.prepare(`
      SELECT id, sale_number, total_cents, discount_cents, payment_method,
             change_cents, request_fingerprint, voided, void_reason,
             print_status, print_attempts
      FROM sales WHERE client_request_id = ?
    `).get(clientRequestId);
    if (!sale) return null;

    if (sale.request_fingerprint !== requestFingerprint) {
      fail(409, "Chiave di incasso gia' usata per una richiesta diversa");
    }
    if (isSalePending(sale.id)) {
      fail(409, {
        error: "Incasso ancora in elaborazione. Attendi un istante e riprova.",
        retryable: true,
      });
    }
    if (sale.voided) {
      fail(
        409,
        `La vendita #${String(sale.sale_number).padStart(4, "0")} associata a questo tentativo e' stata annullata. Avvia un nuovo incasso.`
      );
    }
    if (sale.print_status === "pending" || sale.print_status === "failed") {
      const uncertain = sale.print_status === "pending";
      fail(409, {
        error: uncertain
          ? `Vendita #${String(sale.sale_number).padStart(4, "0")} registrata, ma esito stampa incerto. Verifica la stampante e usa Ristampa dallo storico.`
          : `Vendita #${String(sale.sale_number).padStart(4, "0")} registrata, ma stampa non riuscita. Usa Ristampa dallo storico.`,
        sale_recorded: true,
        sale_number: sale.sale_number,
        total_cents: sale.total_cents,
        print_status: sale.print_status,
        print_attempts: sale.print_attempts,
      });
    }

    return {
      kind: "replay",
      response: {
        ok: true,
        idempotent_replay: true,
        sale_number: sale.sale_number,
        total_cents: sale.total_cents,
        subtotal_cents: sale.total_cents + sale.discount_cents,
        discount_cents: sale.discount_cents,
        payment_method: sale.payment_method,
        change_cents: sale.change_cents,
        print_status: sale.print_status,
        print_attempts: sale.print_attempts,
      },
    };
  }

  function normalizeItems(body) {
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) fail(400, "Carrello vuoto");
    if (items.length > 100) fail(400, "Troppi articoli nel carrello");

    const normalized = items.map(item => {
      const rawNote = item?.note;
      const note = rawNote == null || String(rawNote).trim() === ""
        ? null
        : cleanText(rawNote, 240);
      return {
        product_id: item?.product_id,
        qty: item?.qty,
        expected_unit_price_cents: item?.expected_unit_price_cents,
        selected_option_value_ids: Array.isArray(item?.selected_option_value_ids)
          ? [...item.selected_option_value_ids].sort((left, right) => left - right)
          : [],
        note,
        invalid_note: note === null && rawNote != null && String(rawNote).trim() !== "",
      };
    });
    const invalidItem = normalized.some(item => (
      !Number.isSafeInteger(item.product_id) || item.product_id <= 0
      || !Number.isSafeInteger(item.qty) || item.qty <= 0 || item.qty > MAX_QTY
      || (item.expected_unit_price_cents !== undefined
        && !isValidCents(item.expected_unit_price_cents, MAX_PRODUCT_PRICE_CENTS))
      || item.invalid_note
      || item.selected_option_value_ids.length > 50
      || item.selected_option_value_ids.some(id => !Number.isSafeInteger(id) || id <= 0)
      || new Set(item.selected_option_value_ids).size !== item.selected_option_value_ids.length
    ));
    if (invalidItem) {
      fail(400, `Ogni articolo deve avere id valido e quantita' tra 1 e ${MAX_QTY}`);
    }
    for (const item of normalized) delete item.invalid_note;

    const signatures = normalized.map(item => JSON.stringify([
      item.product_id,
      item.selected_option_value_ids,
      item.note,
    ]));
    if (new Set(signatures).size !== signatures.length) {
      fail(400, "La stessa riga compare piu' volte nel carrello");
    }
    return normalized;
  }

  function calculateDiscount(body, subtotalCents) {
    let discountType = null;
    let discountValue = null;
    let discountCents = 0;
    const discount = body?.discount;
    if (!discount || !discount.type || discount.type === "none") {
      return { discountType, discountValue, discountCents };
    }

    const type = String(discount.type);
    if (type === "gift") {
      discountType = "gift";
      discountCents = subtotalCents;
    } else if (type === "percent") {
      const percent = discount.value;
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        fail(400, "Percentuale sconto non valida (0-100)");
      }
      discountType = "percent";
      discountValue = Math.round(percent * 100) / 100;
      discountCents = Math.round(subtotalCents * discountValue / 100);
    } else if (type === "amount") {
      const amount = discount.value;
      if (!isValidCents(amount, MAX_MONEY_CENTS)) {
        fail(400, "Importo sconto non valido");
      }
      discountType = "amount";
      discountValue = amount;
      discountCents = Math.min(amount, subtotalCents);
    } else {
      fail(400, "Tipo di sconto non valido");
    }
    return { discountType, discountValue, discountCents };
  }

  function buildComputedItems(normalized) {
    const productIds = [...new Set(normalized.map(item => item.product_id))];
    const placeholders = productIds.map(() => "?").join(",");
    const products = database.prepare(`
      SELECT id, name, category, price_cents, sold_out, stock, cost_cents
      FROM products
      WHERE active=1 AND id IN (${placeholders})
    `).all(...productIds);
    const productsById = new Map(products.map(product => [product.id, product]));
    const optionCatalog = loadOptionCatalog(productIds);
    const stockRequested = new Map();

    for (const item of normalized) {
      const product = productsById.get(item.product_id);
      if (!product) fail(400, `Prodotto non valido o non attivo: ${item.product_id}`);
      if (product.sold_out) fail(409, `Prodotto esaurito: ${product.name}`);
      stockRequested.set(product.id, (stockRequested.get(product.id) || 0) + item.qty);
    }
    for (const [productId, quantity] of stockRequested) {
      const product = productsById.get(productId);
      if (product.stock != null && product.stock < quantity) {
        fail(409, `Scorte insufficienti per ${product.name}: disponibili ${product.stock}`);
      }
    }

    const computedItems = [];
    for (const item of normalized) {
      const product = productsById.get(item.product_id);
      const resolved = resolveSelectedOptions(item, optionCatalog.get(product.id) || []);
      if (resolved.error) fail(409, { error: resolved.error, code: "CATALOG_CHANGED" });
      const optionDelta = resolved.selected.reduce(
        (sum, option) => sum + option.price_delta_cents,
        0
      );
      const unitPrice = product.price_cents + optionDelta;
      if (!isValidCents(unitPrice, MAX_PRODUCT_PRICE_CENTS)) {
        fail(400, `Prezzo finale non valido per ${product.name}`);
      }
      if (item.expected_unit_price_cents !== undefined
        && item.expected_unit_price_cents !== unitPrice) {
        fail(409, {
          error: `Il prezzo di ${product.name} e' cambiato. Verifica il nuovo totale.`,
          code: "PRICE_CHANGED",
          product_id: product.id,
          current_price_cents: unitPrice,
        });
      }
      computedItems.push({
        product_id: product.id,
        name: product.name,
        category: product.category,
        qty: item.qty,
        base_unit_price_cents: product.price_cents,
        unit_price_cents: unitPrice,
        line_total_cents: unitPrice * item.qty,
        cost_cents: product.cost_cents,
        stock_decremented_qty: product.stock == null ? 0 : item.qty,
        options: resolved.selected,
        options_json: JSON.stringify(resolved.selected),
        note: item.note,
        selected_option_value_ids: item.selected_option_value_ids,
      });
    }
    return { computedItems, productIds, placeholders, stockRequested };
  }

  function persistSale({
    clientRequestId,
    requestFingerprint,
    session,
    orderNote,
    paymentMethod,
    cashReceivedCents,
    changeCents,
    discountType,
    discountValue,
    discountCents,
    totalCents,
    computedItems,
    productIds,
    placeholders,
    stockRequested,
  }) {
    const transaction = database.transaction(() => {
      const currentProducts = database.prepare(`
        SELECT id, name, price_cents, sold_out, stock FROM products
        WHERE active=1 AND id IN (${placeholders})
      `).all(...productIds);
      const currentById = new Map(currentProducts.map(product => [product.id, product]));
      const currentOptionCatalog = loadOptionCatalog(productIds);
      for (const item of computedItems) {
        const current = currentById.get(item.product_id);
        const resolved = current
          ? resolveSelectedOptions(
            { selected_option_value_ids: item.selected_option_value_ids },
            currentOptionCatalog.get(item.product_id) || []
          )
          : { error: "Prodotto non disponibile" };
        const currentUnit = current && !resolved.error
          ? current.price_cents + resolved.selected.reduce(
            (sum, option) => sum + option.price_delta_cents,
            0
          )
          : null;
        if (!current || resolved.error || currentUnit !== item.unit_price_cents
          || JSON.stringify(resolved.selected || []) !== item.options_json) {
          const error = conflictError(
            current
              ? `Il prezzo di ${current.name} e' cambiato. Verifica il nuovo totale.`
              : `Il prodotto ${item.name} non e' piu' disponibile. Verifica la comanda.`
          );
          error.code = current ? "PRICE_CHANGED" : "CATALOG_CHANGED";
          error.productId = item.product_id;
          error.currentPriceCents = currentUnit;
          throw error;
        }
        const requestedQuantity = stockRequested.get(item.product_id);
        if (current.sold_out || (current.stock != null && current.stock < requestedQuantity)) {
          const error = conflictError(
            current.sold_out
              ? `Prodotto esaurito: ${current.name}`
              : `Scorte insufficienti per ${current.name}: disponibili ${current.stock}`
          );
          error.code = "CATALOG_CHANGED";
          error.productId = item.product_id;
          throw error;
        }
      }

      const saleNumber = getNextSaleNumber();
      const saleInfo = database.prepare(`
        INSERT INTO sales
          (sale_number, client_request_id, request_fingerprint,
           total_cents, discount_cents, discount_type, discount_value,
           payment_method, cash_received_cents, change_cents, operator, session_id, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        saleNumber,
        clientRequestId,
        requestFingerprint,
        totalCents,
        discountCents,
        discountType,
        discountValue,
        paymentMethod,
        cashReceivedCents,
        changeCents,
        session.operator,
        session.id,
        orderNote
      );
      const saleId = saleInfo.lastInsertRowid;
      const insertItem = database.prepare(`
        INSERT INTO sale_items
          (sale_id, product_id, qty, unit_price_cents, base_unit_price_cents, line_total_cents,
           product_name, product_category, product_cost_cents, stock_decremented_qty,
           options_json, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const indexItemName = database.prepare(`
        INSERT INTO sale_items_search(rowid, product_name) VALUES (?, ?)
      `);
      for (const item of computedItems) {
        const itemInfo = insertItem.run(
          saleId,
          item.product_id,
          item.qty,
          item.unit_price_cents,
          item.base_unit_price_cents,
          item.line_total_cents,
          item.name,
          item.category,
          item.cost_cents,
          item.stock_decremented_qty,
          item.options_json,
          item.note
        );
        indexItemName.run(itemInfo.lastInsertRowid, item.name);
      }
      const decrementStock = database.prepare(`
        UPDATE products SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL
      `);
      for (const [productId, quantity] of stockRequested) {
        decrementStock.run(quantity, productId);
      }
      const sale = database.prepare(
        "SELECT id, sale_number, total_cents, created_at FROM sales WHERE id=?"
      ).get(saleId);
      return { saleId, saleNumber: sale.sale_number, createdAt: sale.created_at };
    });

    try {
      return transaction.immediate();
    } catch (error) {
      if (error.code === "PRICE_CHANGED" || error.code === "CATALOG_CHANGED") {
        fail(409, {
          error: error.publicMessage,
          code: error.code,
          product_id: error.productId,
          current_price_cents: error.currentPriceCents,
        });
      }
      throw error;
    }
  }

  function execute(body, rawIdempotencyKey) {
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) fail(400, "Carrello vuoto");
    const paymentMethod = String(body?.payment_method || "cash");
    if (!paymentMethods.has(paymentMethod)) fail(400, "Metodo di pagamento non valido");
    const normalized = normalizeItems(body);

    const rawOrderNote = body?.note;
    const orderNote = rawOrderNote == null || String(rawOrderNote).trim() === ""
      ? null
      : cleanText(rawOrderNote, 500);
    if (orderNote === null && rawOrderNote != null && String(rawOrderNote).trim() !== "") {
      fail(400, "Nota comanda non valida (massimo 500 caratteri)");
    }

    if (!rawIdempotencyKey) fail(400, "Chiave di incasso obbligatoria");
    const clientRequestId = String(rawIdempotencyKey).trim();
    if (!IDEMPOTENCY_KEY_RE.test(clientRequestId)) fail(400, "Chiave di incasso non valida");
    const priorRequest = database.prepare(
      "SELECT session_id FROM sales WHERE client_request_id = ?"
    ).get(clientRequestId);
    const session = getOpenSession();
    if (!session && !priorRequest) {
      fail(409, "Nessun turno di cassa aperto. Apri la cassa prima di vendere.");
    }
    const fingerprintSessionId = priorRequest?.session_id ?? session?.id;
    if (!Number.isSafeInteger(fingerprintSessionId)) {
      fail(409, "La richiesta precedente non e' associata a un turno valido");
    }
    const requestFingerprint = idempotencyFingerprint(
      fingerprintSessionId,
      normalized,
      paymentMethod,
      body
    );
    const replay = replayExistingSale(clientRequestId, requestFingerprint);
    if (replay) return replay;

    const catalog = buildComputedItems(normalized);
    const subtotalCents = catalog.computedItems.reduce(
      (sum, item) => sum + item.line_total_cents,
      0
    );
    if (!isValidCents(subtotalCents, MAX_MONEY_CENTS)) {
      fail(400, "Totale carrello fuori limite");
    }
    const discount = calculateDiscount(body, subtotalCents);
    const totalCents = subtotalCents - discount.discountCents;

    let cashReceivedCents = null;
    let changeCents = null;
    if (paymentMethod === "cash") {
      const received = body?.cash_received_cents;
      cashReceivedCents = received === undefined || received === null ? totalCents : received;
      if (!isValidCents(cashReceivedCents, MAX_MONEY_CENTS)
        || cashReceivedCents < totalCents) {
        fail(400, "Contanti ricevuti insufficienti");
      }
      changeCents = cashReceivedCents - totalCents;
    }

    const result = persistSale({
      clientRequestId,
      requestFingerprint,
      session,
      orderNote,
      paymentMethod,
      cashReceivedCents,
      changeCents,
      subtotalCents,
      ...discount,
      totalCents,
      ...catalog,
    });
    return {
      kind: "created",
      saleId: result.saleId,
      sessionId: session.id,
      saleNumber: result.saleNumber,
      totalCents,
      printPayload: {
        saleNumber: result.saleNumber,
        createdAt: result.createdAt,
        items: catalog.computedItems,
        subtotalCents,
        discountCents: discount.discountCents,
        discountType: discount.discountType,
        discountValue: discount.discountValue,
        totalCents,
        paymentMethod,
        cashReceivedCents,
        changeCents,
        operator: session.operator,
        orderNote,
      },
      response: {
        ok: true,
        sale_number: result.saleNumber,
        total_cents: totalCents,
        subtotal_cents: subtotalCents,
        discount_cents: discount.discountCents,
        payment_method: paymentMethod,
        change_cents: changeCents,
      },
    };
  }

  return { execute };
}

module.exports = { createCheckoutService, idempotencyFingerprint };
