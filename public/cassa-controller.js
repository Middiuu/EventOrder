/* exported initCassa */
/* global APP_CONFIG, api, closeModal, escapeHtml, eurToCents, euro, money, openModal, refreshShellData, showToast, topOpenModal, uiAlert, uiConfirm, uiError, uiPrompt, updateSessionCard, withFormSubmitLock */
// Controller della pagina Cassa. Lo stato operativo resta confinato alla
// singola inizializzazione e viene annullato dal lifecycle SPA.
async function initCassa(signal) {
  const grid = document.querySelector("#productsGrid");
  const cartEl = document.querySelector("#cart");
  const totalEl = document.querySelector("#total");
  const printBtn = document.querySelector("#printBtn");
  const clearBtn = document.querySelector("#clearBtn");
  const searchEl = document.querySelector("#search");
  const categoryFiltersEl = document.querySelector("#categoryFilters");
  const cartCard = document.querySelector("#cartCard");
  const cartHelper = document.querySelector("#cartHelper");
  const mobileCartBar = document.querySelector("#mobileCartBar");
  const mobileCartCount = document.querySelector("#mobileCartCount");
  const mobileCartTotal = document.querySelector("#mobileCartTotal");
  const suspendCartBtn = document.querySelector("#suspendCartBtn");
  const suspendedCartsBtn = document.querySelector("#suspendedCartsBtn");
  const suspendedCartsCount = document.querySelector("#suspendedCartsCount");
  const suspendedCartsModal = document.querySelector("#suspendedCartsModal");
  const suspendedCartsList = document.querySelector("#suspendedCartsList");
  const orderNoteEl = document.querySelector("#orderNote");
  const itemOptionsModal = document.querySelector("#itemOptionsModal");
  const itemOptionsForm = document.querySelector("#itemOptionsForm");
  const itemOptionsTitle = document.querySelector("#itemOptionsTitle");
  const itemOptionsPrice = document.querySelector("#itemOptionsPrice");
  const itemOptionGroups = document.querySelector("#itemOptionGroups");
  const itemNoteEl = document.querySelector("#itemNote");
  const confirmItemOptionsBtn = document.querySelector("#confirmItemOptionsBtn");

  // Barra turno
  const sessionBar = document.querySelector("#sessionBar");
  const sessionStatus = document.querySelector("#sessionStatus");
  const openSessionBtn = document.querySelector("#openSessionBtn");
  const closeSessionBtn = document.querySelector("#closeSessionBtn");
  const openSessionModal = document.querySelector("#openSessionModal");
  const openSessionForm = document.querySelector("#openSessionForm");
  const operatorField = document.querySelector("#operatorField");
  const operatorInput = operatorField?.querySelector('[name="operator"]');
  const operatorOptions = operatorField?.querySelector("#operatorOptions");
  const closeSessionModal = document.querySelector("#closeSessionModal");
  const closeSessionForm = document.querySelector("#closeSessionForm");
  const closeSummary = document.querySelector("#closeSummary");
  const closeDifferenceEl = document.querySelector("#closeDifference");

  // Modale movimento di cassa
  const movementBtn = document.querySelector("#movementBtn");
  const movementModal = document.querySelector("#movementModal");
  const movementForm = document.querySelector("#movementForm");
  const movementExpectedEl = document.querySelector("#movementExpected");
  const movDirBtns = Array.from(document.querySelectorAll(".mov-dir"));

  // Modale pagamento
  const paymentModal = document.querySelector("#paymentModal");
  const payTotalEl = document.querySelector("#payTotal");
  const cashPanel = document.querySelector("#cashPanel");
  const cashReceivedEl = document.querySelector("#cashReceived");
  const quickCashEl = document.querySelector("#quickCash");
  const payChangeEl = document.querySelector("#payChange");
  const confirmPayBtn = document.querySelector("#confirmPayBtn");
  const payMethodBtns = Array.from(document.querySelectorAll(".pay-method"));
  const discOptBtns = Array.from(document.querySelectorAll(".disc-opt"));
  const discValueField = document.querySelector("#discValueField");
  const discValueEl = document.querySelector("#discValue");
  const discValueLabel = document.querySelector("#discValueLabel");
  const discLine = document.querySelector("#discLine");
  const discLineLabel = document.querySelector("#discLineLabel");
  const discLineAmount = document.querySelector("#discLineAmount");

  if (!grid) return;

  let products = await api("/api/products");
  let filtered = [...products];
  let selectedCategory = null;

  function productCategory(product) {
    return String(product.category || "").trim() || "Generale";
  }

  function catalogCategories() {
    const counts = new Map();
    for (const product of products) {
      const category = productCategory(product);
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, APP_CONFIG.locale, { sensitivity: "base" }));
  }

  function renderCategoryFilters() {
    if (!categoryFiltersEl) return;
    const categories = catalogCategories();
    if (selectedCategory && !categories.some(([category]) => category === selectedCategory)) {
      selectedCategory = null;
    }

    categoryFiltersEl.innerHTML = "";
    const options = [[null, "Tutte", products.length], ...categories.map(([category, count]) => [category, category, count])];
    for (const [value, label, count] of options) {
      const button = document.createElement("button");
      const active = value === selectedCategory;
      button.type = "button";
      button.className = `category-filter${active ? " is-active" : ""}`;
      button.setAttribute("aria-pressed", String(active));

      const name = document.createElement("span");
      name.textContent = label;
      const badge = document.createElement("span");
      badge.className = "category-filter-count";
      badge.setAttribute("aria-hidden", "true");
      badge.textContent = count;
      button.append(name, badge);

      button.addEventListener("click", () => {
        selectedCategory = value;
        for (const candidate of categoryFiltersEl.querySelectorAll(".category-filter")) {
          const candidateActive = candidate === button;
          candidate.classList.toggle("is-active", candidateActive);
          candidate.setAttribute("aria-pressed", String(candidateActive));
        }
        applySearch();
      });
      categoryFiltersEl.appendChild(button);
    }
  }

  function newCheckoutRequestId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `eo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  async function loadFreshProducts() {
    products = await api("/api/products");
    renderCategoryFilters();
    applySearch();
    return products;
  }

  // Ricarica best-effort per gli aggiornamenti non critici del catalogo.
  async function reloadProducts() {
    try { await loadFreshProducts(); } catch {
      // in caso di errore si continua con l'elenco già caricato
    }
  }

  const cart = new Map();
  const CART_DRAFT_KEY = "eventorder-current-cart-v1";
  const CHECKOUT_ATTEMPT_KEY = "eventorder-pending-checkout-v1";
  const MOVEMENT_ATTEMPT_KEY = "eventorder-pending-movement-v1";
  const SUSPEND_ATTEMPT_KEY = "eventorder-pending-suspend-v1";
  const RESUME_ATTEMPT_KEY = "eventorder-pending-resume-v1";
  let cartPersistenceReady = false;
  let suspendedCarts = [];
  let itemEditor = null;
  let isPrinting = false;
  // Un tentativo dall'esito incerto conserva chiave e payload esatti: riaprire
  // la modale non puo' trasformare un retry in una seconda vendita.
  let checkoutAttempt = null;
  let movementAttempt = null;
  let suspendAttempt = null;
  let resumeAttempt = null;
  let session = null;
  let databaseInstanceId = null;
  let payMethod = "cash";
  let discType = "none"; // none | percent | amount | gift
  let movDirection = "out"; // out = prelievo | in = versamento

  function persistAttempt(storageKey, value) {
    try {
      if (value) localStorage.setItem(storageKey, JSON.stringify(value));
      else localStorage.removeItem(storageKey);
    } catch {
      // Il server resta idempotente anche se lo storage del browser e' disabilitato.
    }
  }

  function loadAttempt(storageKey) {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (!value) return null;
      if (value.session_id !== session?.id
        || value.database_instance_id !== databaseInstanceId
        || typeof value.requestId !== "string") {
        persistAttempt(storageKey, null);
        return null;
      }
      return value;
    } catch {
      persistAttempt(storageKey, null);
      return null;
    }
  }

  function setCheckoutAttempt(value) {
    checkoutAttempt = value;
    persistAttempt(CHECKOUT_ATTEMPT_KEY, value ? {
      ...value, session_id: session?.id, database_instance_id: databaseInstanceId,
    } : null);
  }

  function setMovementAttempt(value) {
    movementAttempt = value;
    persistAttempt(MOVEMENT_ATTEMPT_KEY, value ? {
      ...value, session_id: session?.id, database_instance_id: databaseInstanceId,
    } : null);
  }

  function setSuspendAttempt(value) {
    suspendAttempt = value;
    persistAttempt(SUSPEND_ATTEMPT_KEY, value ? {
      ...value, session_id: session?.id, database_instance_id: databaseInstanceId,
    } : null);
  }

  function setResumeAttempt(value) {
    resumeAttempt = value;
    persistAttempt(RESUME_ATTEMPT_KEY, value ? {
      ...value, session_id: session?.id, database_instance_id: databaseInstanceId,
    } : null);
  }

  function restoreCheckoutUi() {
    if (!checkoutAttempt) return;
    try {
      const body = JSON.parse(checkoutAttempt.payload);
      payMethod = ["cash", "card", "other"].includes(body.payment_method) ? body.payment_method : "cash";
      payMethodBtns.forEach(button => button.classList.toggle(
        "is-active", button.getAttribute("data-method") === payMethod
      ));
      discType = body.discount?.type || "none";
      discOptBtns.forEach(button => button.classList.toggle(
        "is-active", button.getAttribute("data-disc") === discType
      ));
      const needsDiscountValue = discType === "percent" || discType === "amount";
      if (discValueField) discValueField.hidden = !needsDiscountValue;
      if (discValueEl && needsDiscountValue) {
        discValueEl.value = discType === "amount"
          ? (Number(body.discount?.value || 0) / 100).toFixed(2)
          : String(body.discount?.value ?? "");
      }
      if (cashReceivedEl && body.cash_received_cents != null) {
        cashReceivedEl.value = (Number(body.cash_received_cents) / 100).toFixed(2);
      }
      refreshPayment();
    } catch {
      setCheckoutAttempt(null);
    }
  }

  function guardPendingCheckout() {
    if (!checkoutAttempt) return false;
    showToast("Concludi prima l'incasso in sospeso");
    openModal(paymentModal);
    setCheckoutControlsLocked(true);
    return true;
  }

  function cartTotal() {
    let total = 0;
    for (const it of cart.values()) total += it.qty * it.unit_price_cents;
    return total;
  }

  function buildCartItem(product, qty, selectedIds = [], note = null) {
    const normalizedIds = [...new Set(selectedIds.map(Number))].sort((a, b) => a - b);
    const selectedSet = new Set(normalizedIds);
    const groups = product.option_groups || [];
    const known = new Set(groups.flatMap(group => group.options.map(option => option.id)));
    if (normalizedIds.some(id => !known.has(id))) return { error: "Opzione non più disponibile" };
    const selectedOptions = [];
    for (const group of groups) {
      const selected = group.options.filter(option => selectedSet.has(option.id));
      if (group.required && selected.length === 0) return { error: `Scegli un'opzione per ${group.name}` };
      if (group.selection_type === "single" && selected.length > 1) return { error: `Scegli una sola opzione per ${group.name}` };
      for (const option of selected) {
        selectedOptions.push({
          group_id: group.id,
          group_name: group.name,
          value_id: option.id,
          name: option.name,
          price_delta_cents: option.price_delta_cents,
        });
      }
    }
    const cleanNote = String(note || "").trim().slice(0, 240) || null;
    const unitPrice = product.price_cents
      + selectedOptions.reduce((sum, option) => sum + option.price_delta_cents, 0);
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) return { error: "Prezzo finale non valido" };
    const key = JSON.stringify([product.id, normalizedIds, cleanNote]);
    return {
      key,
      item: {
        product,
        qty,
        selected_option_value_ids: normalizedIds,
        selected_options: selectedOptions,
        note: cleanNote,
        unit_price_cents: unitPrice,
      },
    };
  }

  function cartQtyForProduct(productId, exceptKey = null) {
    let qty = 0;
    for (const [key, item] of cart) {
      if (key !== exceptKey && item.product.id === productId) qty += item.qty;
    }
    return qty;
  }

  function persistCurrentCart() {
    if (!cartPersistenceReady) return;
    try {
      if (cart.size === 0) {
        localStorage.removeItem(CART_DRAFT_KEY);
        return;
      }
      localStorage.setItem(CART_DRAFT_KEY, JSON.stringify({
        session_id: session?.id ?? null,
        database_instance_id: databaseInstanceId,
        saved_at: new Date().toISOString(),
        note: orderNoteEl?.value.trim() || null,
        items: Array.from(cart.values()).map(it => ({
          product_id: it.product.id,
          qty: it.qty,
          selected_option_value_ids: it.selected_option_value_ids,
          note: it.note,
        })),
      }));
    } catch {
      // Lo storage locale può essere disabilitato: il POS resta utilizzabile.
    }
  }

  function recoverCurrentCart() {
    let draft;
    try {
      draft = JSON.parse(localStorage.getItem(CART_DRAFT_KEY) || "null");
    } catch {
      try { localStorage.removeItem(CART_DRAFT_KEY); } catch {}
      return { recovered: false, skipped: [] };
    }
    if (!draft || !Array.isArray(draft.items)) return { recovered: false, skipped: [] };
    if (draft.database_instance_id !== databaseInstanceId
      || (draft.session_id != null && draft.session_id !== session?.id)) {
      try { localStorage.removeItem(CART_DRAFT_KEY); } catch {}
      return { recovered: false, skipped: [] };
    }

    const byId = new Map(products.map(product => [product.id, product]));
    let recovered = 0;
    const skipped = [];
    const usedStock = new Map();
    if (orderNoteEl) orderNoteEl.value = String(draft.note || "").slice(0, 500);
    for (const item of draft.items) {
      const product = byId.get(item?.product_id);
      if (!product || !Number.isSafeInteger(item?.qty) || item.qty <= 0 || !productAvailable(product)) {
        skipped.push(product?.name || `Prodotto #${item?.product_id || "?"}`);
        continue;
      }
      const built = buildCartItem(product, item.qty, item.selected_option_value_ids || [], item.note);
      if (built.error) {
        skipped.push(product.name);
        continue;
      }
      const alreadyUsed = usedStock.get(product.id) || 0;
      const qty = product.stock == null ? item.qty : Math.min(item.qty, Math.max(0, product.stock - alreadyUsed));
      if (qty <= 0) {
        skipped.push(product.name);
        continue;
      }
      if (qty !== item.qty) skipped.push(product.name);
      built.item.qty = qty;
      cart.set(built.key, built.item);
      usedStock.set(product.id, alreadyUsed + qty);
      recovered += qty;
    }
    return { recovered: recovered > 0, skipped: [...new Set(skipped)] };
  }

  function reconcileCartWithCatalog() {
    const byId = new Map(products.map(product => [product.id, product]));
    const oldTotal = cartTotal();
    const priceChanges = [];
    const removed = [];
    const unavailable = [];

    const reconciled = new Map();
    const requestedStock = new Map();
    for (const item of cart.values()) {
      const current = byId.get(item.product.id);
      if (!current) {
        removed.push(item.product.name);
        continue;
      }
      const built = buildCartItem(current, item.qty, item.selected_option_value_ids, item.note);
      if (built.error) {
        removed.push(`${current.name} (${built.error})`);
        continue;
      }
      if (built.item.unit_price_cents !== item.unit_price_cents) {
        priceChanges.push({ name: current.name, from: item.unit_price_cents, to: built.item.unit_price_cents });
      }
      reconciled.set(built.key, built.item);
      requestedStock.set(current.id, (requestedStock.get(current.id) || 0) + item.qty);
      if (!productAvailable(current)) {
        unavailable.push(current.name);
      }
    }
    cart.clear();
    for (const [key, item] of reconciled) cart.set(key, item);
    for (const [productId, qty] of requestedStock) {
      const product = byId.get(productId);
      if (product?.stock != null && qty > product.stock) unavailable.push(product.name);
    }
    return { oldTotal, newTotal: cartTotal(), priceChanges, removed, unavailable };
  }

  // ---- Turno di cassa
  function renderSession() {
    if (sessionBar) sessionBar.hidden = false;
    const open = Boolean(session);
    if (sessionStatus) {
      sessionStatus.textContent = open
        ? `Cassa aperta${session.operator ? " · " + session.operator : ""}`
        : "Cassa chiusa";
      sessionStatus.classList.toggle("is-active", open);
      sessionStatus.classList.toggle("is-inactive", !open);
    }
    if (openSessionBtn) openSessionBtn.hidden = open;
    if (closeSessionBtn) closeSessionBtn.hidden = !open;
    if (movementBtn) movementBtn.hidden = !open;
    if (cartHelper) {
      cartHelper.textContent = open
        ? "La stampa registra la vendita e genera il ticket della comanda corrente."
        : "Apri la cassa (con il fondo iniziale) per abilitare la vendita.";
    }
    updateSessionCard(session);
  }

  async function refreshSession() {
    try {
      const data = await api("/api/sessions/current");
      session = data.session || null;
      databaseInstanceId = data.database_instance_id;
    } catch {
      session = null;
      databaseInstanceId = null;
    }
    renderSession();
    renderCart();
    await refreshSuspendedCarts();
  }

  function populateOperators() {
    const ops = (APP_CONFIG.operators || []);
    if (!operatorField || !operatorInput) return;
    operatorField.hidden = false;
    if (operatorOptions) {
      operatorOptions.innerHTML = ops.map(o => `<option value="${escapeHtml(o)}"></option>`).join("");
    }
    if (ops.length > 0) {
      operatorInput.setAttribute("list", "operatorOptions");
      if (!ops.includes(operatorInput.value)) operatorInput.value = ops[0];
    } else {
      operatorInput.removeAttribute("list");
    }
  }

  openSessionBtn?.addEventListener("click", () => {
    populateOperators();
    openModal(openSessionModal);
  });

  openSessionForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const floatCents = eurToCents(openSessionForm.float_eur.value || "0");
    if (floatCents === null) return uiAlert("Fondo cassa non valido.");
    const operator = operatorInput && !operatorField.hidden
      ? String(operatorInput.value || "").trim() || undefined
      : undefined;
    await withFormSubmitLock(openSessionForm, async () => {
      try {
        await api("/api/sessions/open", {
          method: "POST",
          body: JSON.stringify({ opening_float_cents: floatCents, operator })
        });
        closeModal(openSessionModal);
        showToast("Cassa aperta");
        await refreshSession();
      } catch (err) {
        await uiError(err);
      }
    });
  });

  function renderCloseSummary() {
    const t = session?.totals || {};
    const expected = t.expectedCashCents || 0;
    const movIn = t.movementsInCents || 0;
    const movOut = t.movementsOutCents || 0;
    if (closeSummary) {
      closeSummary.innerHTML = `
        <div class="row"><div>Fondo cassa iniziale</div><div>${money(session?.opening_float_cents || 0)}</div></div>
        <div class="row"><div>Incasso contanti</div><div>${money((t.byMethod?.cash) || 0)}</div></div>
        ${movIn > 0 ? `<div class="row"><div>Versamenti</div><div>+ ${money(movIn)}</div></div>` : ""}
        ${movOut > 0 ? `<div class="row"><div>Prelievi</div><div>− ${money(movOut)}</div></div>` : ""}
        <div class="row"><div><b>Contanti attesi in cassa</b></div><div><b>${money(expected)}</b></div></div>
      `;
    }
    updateCloseDifference();
  }

  function updateCloseDifference() {
    if (!closeSessionForm || !closeDifferenceEl) return;
    const counted = eurToCents(closeSessionForm.counted_eur.value);
    const expected = session?.totals?.expectedCashCents || 0;
    if (counted === null) { closeDifferenceEl.textContent = money(0); closeDifferenceEl.className = ""; return; }
    const diff = counted - expected;
    closeDifferenceEl.textContent = (diff >= 0 ? "+" : "−") + " " + money(Math.abs(diff));
    closeDifferenceEl.className = diff === 0 ? "diff-ok" : (diff > 0 ? "diff-plus" : "diff-minus");
  }

  closeSessionBtn?.addEventListener("click", () => {
    if (cart.size > 0) {
      void uiAlert("Sospendi o svuota la comanda corrente prima di chiudere la cassa.");
      return;
    }
    if (closeSessionForm) closeSessionForm.counted_eur.value = "";
    renderCloseSummary();
    openModal(closeSessionModal);
  });
  closeSessionForm?.addEventListener("input", updateCloseDifference);
  closeSessionForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const counted = eurToCents(closeSessionForm.counted_eur.value);
    if (counted === null) return uiAlert("Inserisci i contanti contati.");
    await withFormSubmitLock(closeSessionForm, async () => {
      try {
        const data = await api("/api/sessions/close", {
          method: "POST",
          body: JSON.stringify({ counted_cash_cents: counted })
        });
        const diff = data.session.difference_cents;
        closeModal(closeSessionModal);
        showToast(`Cassa chiusa • differenza ${diff >= 0 ? "+" : "−"} ${money(Math.abs(diff))}`);
        await refreshSession();
      } catch (err) {
        await uiError(err);
      }
    });
  });

  // ---- Movimenti di cassa (prelievi / versamenti a turno aperto)
  function setMovementDirection(dir) {
    movDirection = dir;
    movDirBtns.forEach(b => b.classList.toggle("is-active", b.getAttribute("data-dir") === dir));
    updateMovementExpected();
  }

  function updateMovementExpected() {
    if (!movementExpectedEl) return;
    const expected = session?.totals?.expectedCashCents || 0;
    const amount = eurToCents(movementForm?.amount_eur.value);
    const next = !amount ? expected : (movDirection === "out" ? expected - amount : expected + amount);
    movementExpectedEl.textContent = money(next);
    movementExpectedEl.className = next < 0 ? "diff-minus" : "";
  }

  movementBtn?.addEventListener("click", () => {
    if (!session) return;
    if (movementAttempt) {
      try {
        const pending = JSON.parse(movementAttempt.payload);
        if (movementForm) {
          movementForm.amount_eur.value = (pending.amount_cents / 100).toFixed(2);
          movementForm.reason.value = pending.reason;
        }
        setMovementDirection(pending.direction);
      } catch {
        setMovementAttempt(null);
        movementForm?.reset();
        setMovementDirection("out");
      }
    } else {
      movementForm?.reset();
      setMovementDirection("out");
    }
    openModal(movementModal);
    setTimeout(() => movementForm?.amount_eur.focus(), 0);
  });
  movDirBtns.forEach(b => b.addEventListener("click", () => setMovementDirection(b.getAttribute("data-dir"))));
  movementForm?.addEventListener("input", updateMovementExpected);
  movementForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = eurToCents(movementForm.amount_eur.value);
    if (!amount) return uiAlert("Inserisci un importo maggiore di zero.");
    const reason = String(movementForm.reason.value || "").trim();
    if (!reason) return uiAlert("Indica il motivo del movimento.");
    if (!movementAttempt) {
      setMovementAttempt({
        requestId: newCheckoutRequestId(),
        payload: JSON.stringify({ direction: movDirection, amount_cents: amount, reason }),
      });
    }
    await withFormSubmitLock(movementForm, async () => {
      try {
        await api("/api/sessions/movements", {
          method: "POST",
          headers: { "Idempotency-Key": movementAttempt.requestId },
          body: movementAttempt.payload,
        });
        setMovementAttempt(null);
        closeModal(movementModal);
        showToast(`${movDirection === "out" ? "Prelievo" : "Versamento"} registrato • ${money(amount)}`);
        await refreshSession();
      } catch (err) {
        if (err.status !== undefined && err.data?.retryable !== true) setMovementAttempt(null);
        await uiError(err);
      }
    });
  });

  // Disponibilità derivata: esaurito manuale oppure scorte tracciate a zero
  function productAvailable(p) {
    return !p.sold_out && !(p.stock != null && p.stock <= 0);
  }

  async function setSoldOut(p, soldOut) {
    try {
      await api(`/api/products/${p.id}`, { method: "PATCH", body: JSON.stringify({ sold_out: soldOut ? 1 : 0 }) });
      showToast(soldOut ? `"${p.name}" segnato esaurito` : `"${p.name}" di nuovo disponibile`);
      await reloadProducts();
    } catch (err) {
      await uiError(err);
    }
  }

  function renderProducts() {
    grid.innerHTML = "";
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "catalog-empty";
      empty.setAttribute("role", "status");
      empty.textContent = "Nessun prodotto corrisponde ai filtri selezionati.";
      grid.appendChild(empty);
      return;
    }
    for (const p of filtered) {
      const available = productAvailable(p);
      const b = document.createElement("button");
      b.className = "btn product-card" + (available ? "" : " is-soldout");
      if (available) {
        b.setAttribute("aria-describedby", "soldOutHint");
        b.setAttribute("aria-keyshortcuts", "Shift+Enter");
      }

      let stockTag = "";
      if (available && p.stock != null) {
        stockTag = ` • <span class="stock-tag${p.stock <= 5 ? " low" : ""}">${p.stock} rimasti</span>`;
      }
      const optionsTag = p.option_groups?.length
        ? ` • <span class="stock-tag">${p.option_groups.length} ${p.option_groups.length === 1 ? "scelta" : "scelte"}</span>`
        : "";
      b.innerHTML = `
        <div class="product-card-title">${escapeHtml(p.name)}${available ? "" : ' <span class="soldout-tag">Esaurito</span>'}</div>
        <div class="product-card-meta">${escapeHtml(p.category)} • <span class="product-price">${euro(p.price_cents)}</span>${stockTag}${optionsTag}</div>
      `;

      // Long-press su una card disponibile: segna il prodotto come esaurito.
      let pressTimer = null;
      let suppressClick = false;
      let soldOutPromptOpen = false;
      const requestSoldOut = async () => {
        if (soldOutPromptOpen) return;
        soldOutPromptOpen = true;
        try {
          const ok = await uiConfirm(`Segnare "${p.name}" come esaurito? Non sarà più vendibile finché non lo rimetti disponibile.`, "Esaurito");
          if (ok) await setSoldOut(p, true);
        } finally {
          soldOutPromptOpen = false;
        }
      };
      const cancelPress = () => {
        clearTimeout(pressTimer);
        pressTimer = null;
        b.classList.remove("is-holding");
      };
      b.addEventListener("pointerdown", (event) => {
        suppressClick = false;
        if (!available || event.button !== 0) return;
        cancelPress();
        b.classList.add("is-holding");
        pressTimer = setTimeout(() => {
          pressTimer = null;
          b.classList.remove("is-holding");
          suppressClick = true;
          void requestSoldOut();
        }, 650);
      });
      b.addEventListener("pointerup", cancelPress);
      b.addEventListener("pointerleave", cancelPress);
      b.addEventListener("pointercancel", cancelPress);
      b.addEventListener("contextmenu", (e) => e.preventDefault());
      b.addEventListener("keydown", (event) => {
        if (!available || event.key !== "Enter" || !event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        void requestSoldOut();
      });

      b.onclick = async () => {
        if (suppressClick) { suppressClick = false; return; }
        if (available) return p.option_groups?.length ? openItemEditor(p) : addProduct(p);
        if (p.sold_out) {
          const ok = await uiConfirm(`Rimettere "${p.name}" disponibile in cassa?`, "Di nuovo disponibile");
          if (ok) await setSoldOut(p, false);
        } else {
          await uiAlert("Scorte terminate: aggiornale dalla pagina Prodotti.");
        }
      };
      grid.appendChild(b);
    }
  }

  function renderCart() {
    cartEl.innerHTML = "";
    let total = 0;
    let itemCount = 0;

    for (const [key, it] of cart.entries()) {
      const line = it.qty * it.unit_price_cents;
      total += line;
      itemCount += it.qty;

      const row = document.createElement("div");
      row.className = "cart-item";
      row.innerHTML = `
        <div style="min-width: 0;">
          <div class="cart-item-title">
            <b>${it.qty}x</b> ${escapeHtml(it.product.name)}
          </div>
          <div class="small">${euro(it.unit_price_cents)} cad.</div>
          <div class="cart-item-details">
            ${(it.selected_options || []).map(option => `<span>${escapeHtml(option.group_name)}: ${escapeHtml(option.name)}</span>`).join("")}
            ${it.note ? `<span>Nota: ${escapeHtml(it.note)}</span>` : ""}
          </div>
        </div>
        <div class="qtyBtns">
          <button class="qtyBtn" data-dec type="button">-</button>
          <button class="qtyBtn" data-inc type="button">+</button>
          <button class="btn btn-secondary cart-detail-btn" data-edit-line type="button">Dettagli</button>
          <div class="line-total">${euro(line)}</div>
        </div>
      `;
      row.querySelector("[data-dec]").dataset.dec = key;
      row.querySelector("[data-inc]").dataset.inc = key;
      row.querySelector("[data-edit-line]").dataset.editLine = key;
      cartEl.appendChild(row);
    }

    totalEl.textContent = euro(total);
    if (mobileCartTotal) mobileCartTotal.textContent = euro(total);
    if (mobileCartCount) {
      mobileCartCount.textContent = itemCount === 0
        ? "Comanda vuota"
        : `${itemCount} ${itemCount === 1 ? "articolo" : "articoli"} nella comanda`;
    }

    const empty = cart.size === 0;
    if (printBtn) printBtn.disabled = empty || isPrinting || !session;
    if (clearBtn) clearBtn.disabled = empty || isPrinting;
    if (suspendCartBtn) suspendCartBtn.disabled = empty || isPrinting || !session || Boolean(checkoutAttempt);
    if (suspendedCartsBtn) suspendedCartsBtn.disabled = !session || isPrinting;
    if (mobileCartBar) {
      mobileCartBar.disabled = empty;
      mobileCartBar.setAttribute("aria-label", empty ? "Comanda vuota" : `Vedi la comanda, totale ${euro(total)}`);
    }
    persistCurrentCart();
  }

  function addProduct(p) {
    if (guardPendingCheckout()) return;
    const built = buildCartItem(p, 1, [], null);
    if (built.error) return void uiAlert(built.error);
    const cur = cart.get(built.key);
    const nextQty = (cur?.qty || 0) + 1;
    if (p.stock != null && cartQtyForProduct(p.id) + 1 > p.stock) {
      showToast(`Disponibili solo ${p.stock} di "${p.name}"`);
      return;
    }
    cart.set(built.key, { ...(cur || built.item), qty: nextQty });
    renderCart();
  }

  function decProduct(key) {
    if (guardPendingCheckout()) return;
    const cur = cart.get(key);
    if (!cur) return;
    const next = cur.qty - 1;
    if (next <= 0) cart.delete(key);
    else cart.set(key, { ...cur, qty: next });
    renderCart();
  }

  function incProduct(key) {
    if (guardPendingCheckout()) return;
    const cur = cart.get(key);
    if (!cur) return;
    const p = cur.product;
    if (p.stock != null && cartQtyForProduct(p.id) + 1 > p.stock) {
      showToast(`Disponibili solo ${p.stock} di "${p.name}"`);
      return;
    }
    cart.set(key, { ...cur, qty: cur.qty + 1 });
    renderCart();
  }

  cartEl.addEventListener("click", (e) => {
    const dec = e.target?.getAttribute?.("data-dec");
    const inc = e.target?.getAttribute?.("data-inc");
    const editLine = e.target?.getAttribute?.("data-edit-line");
    if (dec) decProduct(dec);
    if (inc) incProduct(inc);
    if (editLine && cart.has(editLine)) openItemEditor(cart.get(editLine).product, editLine);
  });

  function refreshItemEditorPrice() {
    if (!itemEditor || !itemOptionsForm) return;
    const selectedIds = [...itemOptionsForm.querySelectorAll("input[data-option-id]:checked")]
      .map(input => Number(input.value)).filter(Boolean);
    const built = buildCartItem(itemEditor.product, 1, selectedIds, itemNoteEl?.value);
    if (itemOptionsPrice) itemOptionsPrice.textContent = built.error ? "—" : money(built.item.unit_price_cents);
  }

  function openItemEditor(product, lineKey = null) {
    if (guardPendingCheckout()) return;
    const existing = lineKey ? cart.get(lineKey) : null;
    itemEditor = { product, lineKey, qty: existing?.qty || 1 };
    if (itemOptionsTitle) itemOptionsTitle.textContent = product.name;
    if (confirmItemOptionsBtn) confirmItemOptionsBtn.textContent = existing ? "Salva dettagli" : "Aggiungi alla comanda";
    if (itemNoteEl) itemNoteEl.value = existing?.note || "";
    if (itemOptionGroups) {
      itemOptionGroups.innerHTML = "";
      const selected = new Set(existing?.selected_option_value_ids || []);
      for (const group of product.option_groups || []) {
        const section = document.createElement("section");
        section.className = "item-option-group";
        const choices = [];
        if (group.selection_type === "single" && !group.required) {
          choices.push(`<label class="item-option-choice"><input type="radio" name="option-group-${group.id}" data-option-id value="" ${group.options.some(option => selected.has(option.id)) ? "" : "checked"}><span>Nessuna</span></label>`);
        }
        for (const option of group.options) {
          const type = group.selection_type === "single" ? "radio" : "checkbox";
          const delta = option.price_delta_cents === 0 ? "" : `${option.price_delta_cents > 0 ? "+" : ""}${money(option.price_delta_cents)}`;
          choices.push(`<label class="item-option-choice"><input type="${type}" name="option-group-${group.id}" data-option-id value="${option.id}" ${selected.has(option.id) ? "checked" : ""}><span><b>${escapeHtml(option.name)}</b><small>${escapeHtml(delta)}</small></span></label>`);
        }
        section.innerHTML = `<div class="item-option-group-head"><b>${escapeHtml(group.name)}</b><span>${group.required ? "Obbligatoria" : "Facoltativa"} · ${group.selection_type === "single" ? "una scelta" : "più scelte"}</span></div><div class="item-option-choices">${choices.join("")}</div>`;
        itemOptionGroups.appendChild(section);
      }
    }
    refreshItemEditorPrice();
    openModal(itemOptionsModal);
  }

  itemOptionsForm?.addEventListener("change", refreshItemEditorPrice);
  itemNoteEl?.addEventListener("input", refreshItemEditorPrice);
  itemOptionsForm?.addEventListener("submit", async event => {
    event.preventDefault();
    if (!itemEditor) return;
    const selectedIds = [...itemOptionsForm.querySelectorAll("input[data-option-id]:checked")]
      .map(input => Number(input.value)).filter(Boolean);
    const built = buildCartItem(itemEditor.product, itemEditor.qty, selectedIds, itemNoteEl?.value);
    if (built.error) return uiAlert(built.error);
    const existingAtTarget = cart.get(built.key);
    const otherQty = cartQtyForProduct(itemEditor.product.id, itemEditor.lineKey);
    const mergedQty = existingAtTarget && built.key !== itemEditor.lineKey
      ? existingAtTarget.qty + itemEditor.qty
      : itemEditor.qty;
    if (itemEditor.product.stock != null && otherQty + mergedQty > itemEditor.product.stock) {
      return uiAlert(`Disponibili solo ${itemEditor.product.stock} di "${itemEditor.product.name}".`);
    }
    if (itemEditor.lineKey) cart.delete(itemEditor.lineKey);
    cart.set(built.key, { ...built.item, qty: mergedQty });
    itemEditor = null;
    closeModal(itemOptionsModal);
    renderCart();
  });

  function applySearch() {
    const q = (searchEl?.value || "").trim().toLocaleLowerCase(APP_CONFIG.locale);
    filtered = products.filter(p => {
      const category = productCategory(p);
      const matchesCategory = selectedCategory === null || category === selectedCategory;
      const searchable = `${p.name} ${category}`.toLocaleLowerCase(APP_CONFIG.locale);
      return matchesCategory && (!q || searchable.includes(q));
    });
    renderProducts();
  }
  searchEl?.addEventListener("input", applySearch);
  orderNoteEl?.addEventListener("input", persistCurrentCart);

  function suspendedCartTotal(entry) {
    return entry.items.reduce((sum, item) => sum + item.qty * (item.expected_unit_price_cents ?? item.price_cents), 0);
  }

  function suspendedItemAvailable(item) {
    return item.active === 1 && !item.sold_out && !(item.stock != null && item.qty > item.stock);
  }

  function renderSuspendedCarts() {
    if (suspendedCartsCount) suspendedCartsCount.textContent = suspendedCarts.length;
    if (!suspendedCartsList) return;
    suspendedCartsList.innerHTML = "";
    if (suspendedCarts.length === 0) {
      const empty = document.createElement("div");
      empty.className = "suspended-empty";
      empty.textContent = "Nessuna comanda sospesa in questo turno.";
      suspendedCartsList.appendChild(empty);
      return;
    }

    for (const entry of suspendedCarts) {
      const unavailable = entry.items.filter(item => !suspendedItemAvailable(item));
      const ticket = document.createElement("article");
      ticket.className = "suspended-ticket";
      const when = entry.created_at
        ? new Date(`${entry.created_at}Z`).toLocaleString(APP_CONFIG.locale, { dateStyle: "short", timeStyle: "short" })
        : "—";
      const summary = entry.items.map(item => {
        const options = (item.selected_options || []).map(option => option.name).join(", ");
        return `${item.qty}x ${escapeHtml(item.name)}${options ? ` (${escapeHtml(options)})` : ""}`;
      }).join(" · ");
      ticket.innerHTML = `
        <div class="suspended-ticket-head">
          <div>
            <div class="suspended-ticket-title">${escapeHtml(entry.label)}</div>
            <div class="suspended-ticket-meta">${escapeHtml(when)}${entry.operator ? ` · ${escapeHtml(entry.operator)}` : ""}</div>
          </div>
          <div class="suspended-ticket-total">${money(suspendedCartTotal(entry))}</div>
        </div>
        <div class="suspended-ticket-items">${summary || "Comanda vuota"}</div>
        ${unavailable.length > 0 ? `<div class="small diff-minus">Da verificare: ${unavailable.map(item => escapeHtml(item.name)).join(", ")}</div>` : ""}
        <div class="suspended-ticket-actions">
          <button class="btn btn-primary btn-compact" type="button" data-resume-cart="${entry.id}">Riprendi</button>
          <button class="btn btn-secondary btn-compact" type="button" data-delete-cart="${entry.id}">Elimina</button>
        </div>`;
      suspendedCartsList.appendChild(ticket);
    }
  }

  async function refreshSuspendedCarts() {
    if (!session) {
      suspendedCarts = [];
      renderSuspendedCarts();
      return;
    }
    try {
      const data = await api("/api/carts");
      suspendedCarts = Array.isArray(data.carts) ? data.carts : [];
      renderSuspendedCarts();
    } catch {
      // Il conteggio precedente resta visibile se l'aggiornamento non riesce.
    }
  }

  suspendCartBtn?.addEventListener("click", async () => {
    if (!session || cart.size === 0 || guardPendingCheckout()) return;
    if (!suspendAttempt) {
      const label = await uiPrompt(
        "Sospendi comanda",
        "Nome o riferimento",
        `Comanda ${suspendedCarts.length + 1}`
      );
      if (label === null) return;
      setSuspendAttempt({
        requestId: newCheckoutRequestId(),
        payload: JSON.stringify({
          label,
          note: orderNoteEl?.value.trim() || null,
          items: Array.from(cart.values()).map(item => ({
            product_id: item.product.id,
            qty: item.qty,
            selected_option_value_ids: item.selected_option_value_ids,
            expected_unit_price_cents: item.unit_price_cents,
            note: item.note,
          })),
        }),
      });
    }
    try {
      await api("/api/carts", {
        method: "POST",
        headers: { "Idempotency-Key": suspendAttempt.requestId },
        body: suspendAttempt.payload,
      });
      setSuspendAttempt(null);
      cart.clear();
      if (orderNoteEl) orderNoteEl.value = "";
      renderCart();
      await refreshSuspendedCarts();
      showToast("Comanda sospesa");
    } catch (err) {
      if (err.status !== undefined && err.data?.retryable !== true) setSuspendAttempt(null);
      await uiError(err);
    }
  });

  suspendedCartsBtn?.addEventListener("click", async () => {
    if (!session) return;
    await refreshSuspendedCarts();
    openModal(suspendedCartsModal);
  });

  async function completeResumeAttempt() {
    if (!resumeAttempt || cart.size > 0) return false;
    const entry = resumeAttempt.entry;
    await loadFreshProducts();
    const byId = new Map(products.map(product => [product.id, product]));
    const restored = entry.items.map(item => {
      const product = byId.get(item.product_id);
      const selectedIds = (item.selected_options || []).map(option => option.value_id);
      const built = product ? buildCartItem(product, item.qty, selectedIds, item.note) : { error: "Prodotto non disponibile" };
      return { item, product, built };
    });
    const requested = new Map();
    for (const { item, product } of restored) {
      if (product) requested.set(product.id, (requested.get(product.id) || 0) + item.qty);
    }
    const invalid = restored.filter(({ product, built }) => (
      !product || built.error || !productAvailable(product)
      || (product.stock != null && (requested.get(product.id) || 0) > product.stock)
    ));
    if (invalid.length > 0) {
      await uiAlert(
        `Non è possibile riprendere la comanda. Verifica: ${invalid.map(({ item }) => item.name).join(", ")}.`,
        "Disponibilità cambiata"
      );
      return false;
    }

    const out = await api(`/api/carts/${entry.id}/resume`, {
      method: "POST",
      headers: { "Idempotency-Key": resumeAttempt.requestId },
      body: "{}",
    });
    const resumedEntry = out.cart || entry;
    for (const { built } of restored) cart.set(built.key, built.item);
    if (orderNoteEl) orderNoteEl.value = resumedEntry.note || "";
    setResumeAttempt(null);
    renderCart();
    closeModal(suspendedCartsModal);
    await refreshSuspendedCarts();
    showToast(`Comanda ripresa • ${resumedEntry.label}`);
    return true;
  }

  suspendedCartsList?.addEventListener("click", async (event) => {
    const resumeId = Number(event.target?.getAttribute?.("data-resume-cart"));
    const deleteId = Number(event.target?.getAttribute?.("data-delete-cart"));
    const id = resumeId || deleteId;
    if (!id) return;
    const entry = suspendedCarts.find(candidate => candidate.id === id);
    if (!entry) return;

    if (resumeId) {
      if (cart.size > 0) {
        await uiAlert("Sospendi o svuota prima la comanda corrente.");
        return;
      }
      try {
        setResumeAttempt({ requestId: newCheckoutRequestId(), entry });
        await completeResumeAttempt();
      } catch (err) {
        if (err.status !== undefined && err.data?.retryable !== true) setResumeAttempt(null);
        await uiError(err);
      }
      return;
    }

    const confirmed = await uiConfirm(`Eliminare la comanda sospesa "${entry.label}"?`, "Elimina comanda");
    if (!confirmed) return;
    try {
      await api(`/api/carts/${id}`, { method: "DELETE" });
      await refreshSuspendedCarts();
      showToast("Comanda eliminata");
    } catch (err) {
      await uiError(err);
    }
  });

  // ---- Sconto / omaggio
  function currentDiscountCents() {
    const subtotal = cartTotal();
    if (discType === "gift") return subtotal;
    if (discType === "percent") {
      const pct = Number(String(discValueEl?.value || "").replace(",", "."));
      if (!Number.isFinite(pct) || pct <= 0) return 0;
      return Math.round(subtotal * Math.min(pct, 100) / 100);
    }
    if (discType === "amount") {
      const c = eurToCents(discValueEl?.value);
      if (c === null) return 0;
      return Math.min(c, subtotal);
    }
    return 0;
  }

  function payableTotal() {
    return cartTotal() - currentDiscountCents();
  }

  function setDiscount(type) {
    discType = type;
    discOptBtns.forEach(b => b.classList.toggle("is-active", b.getAttribute("data-disc") === type));
    const needsValue = type === "percent" || type === "amount";
    if (discValueField) discValueField.hidden = !needsValue;
    if (needsValue && discValueLabel) discValueLabel.textContent = type === "percent" ? "Percentuale (%)" : "Sconto (€)";
    if (needsValue && discValueEl) { discValueEl.value = ""; setTimeout(() => discValueEl.focus(), 0); }
    refreshPayment();
  }

  function discountBody() {
    if (discType === "none") return undefined;
    if (discType === "gift") return { type: "gift" };
    if (discType === "percent") return { type: "percent", value: Number(String(discValueEl?.value || "").replace(",", ".")) || 0 };
    if (discType === "amount") return { type: "amount", value: eurToCents(discValueEl?.value) || 0 };
    return undefined;
  }

  // ---- Pagamento
  function setPayMethod(method) {
    payMethod = method;
    payMethodBtns.forEach(b => b.classList.toggle("is-active", b.getAttribute("data-method") === method));
    if (cashPanel) cashPanel.hidden = method !== "cash";
    updatePayChange();
  }

  function buildQuickCash(total) {
    if (!quickCashEl) return;
    const values = new Set([total]);
    for (const step of [500, 1000, 2000, 5000, 10000]) {
      values.add(Math.ceil(total / step) * step);
    }
    const sorted = [...values].filter(v => v >= total && v > 0).sort((a, b) => a - b).slice(0, 5);
    quickCashEl.innerHTML = sorted.map(v =>
      `<button type="button" class="btn btn-secondary btn-compact quick-cash-btn" data-cash="${v}">${money(v)}</button>`
    ).join("");
    quickCashEl.querySelectorAll("button").forEach(button => {
      button.disabled = Boolean(checkoutAttempt);
    });
  }

  function setCheckoutControlsLocked(locked) {
    [...payMethodBtns, ...discOptBtns].forEach(button => { button.disabled = locked; });
    if (discValueEl) discValueEl.disabled = locked;
    if (cashReceivedEl) cashReceivedEl.disabled = locked;
    quickCashEl?.querySelectorAll("button").forEach(button => { button.disabled = locked; });
  }

  // Aggiorna totale, riga sconto, tasti rapidi e resto in modo coerente
  function refreshPayment() {
    const discount = currentDiscountCents();
    const total = payableTotal();
    if (payTotalEl) payTotalEl.textContent = money(total);
    if (discLine) {
      discLine.hidden = discount <= 0;
      if (discount > 0) {
        if (discLineLabel) discLineLabel.textContent = discType === "gift" ? "Omaggio" : "Sconto";
        if (discLineAmount) discLineAmount.textContent = `− ${money(discount)}`;
      }
    }
    buildQuickCash(total);
    updatePayChange();
  }

  function updatePayChange() {
    if (!payChangeEl) return;
    const total = payableTotal();
    if (payMethod !== "cash" || total <= 0) {
      payChangeEl.textContent = money(0);
      payChangeEl.className = "diff-ok";
      if (confirmPayBtn) confirmPayBtn.disabled = false;
      return;
    }
    const received = eurToCents(cashReceivedEl?.value);
    if (received === null || received < total) {
      payChangeEl.textContent = "—";
      payChangeEl.className = "diff-minus";
      if (confirmPayBtn) confirmPayBtn.disabled = true;
      return;
    }
    payChangeEl.textContent = money(received - total);
    payChangeEl.className = "diff-ok";
    if (confirmPayBtn) confirmPayBtn.disabled = false;
  }

  payMethodBtns.forEach(b => b.addEventListener("click", () => setPayMethod(b.getAttribute("data-method"))));
  discOptBtns.forEach(b => b.addEventListener("click", () => setDiscount(b.getAttribute("data-disc"))));
  discValueEl?.addEventListener("input", refreshPayment);
  cashReceivedEl?.addEventListener("input", updatePayChange);
  quickCashEl?.addEventListener("click", (e) => {
    const v = e.target?.getAttribute?.("data-cash");
    if (!v || !cashReceivedEl) return;
    cashReceivedEl.value = (Number(v) / 100).toFixed(2);
    updatePayChange();
  });

  printBtn?.addEventListener("click", async () => {
    if (!session || cart.size === 0) return;
    if (!checkoutAttempt) {
      try {
        if (printBtn) printBtn.disabled = true;
        await loadFreshProducts();
        const reconciliation = reconcileCartWithCatalog();
        renderCart();
        if (reconciliation.removed.length > 0) {
          await uiAlert(
            `Rimossi dal carrello perché non più nel catalogo: ${reconciliation.removed.join(", ")}. Controlla la comanda prima di continuare.`,
            "Catalogo aggiornato"
          );
          return;
        }
        if (reconciliation.unavailable.length > 0) {
          await uiAlert(
            `Disponibilità insufficiente per: ${reconciliation.unavailable.join(", ")}. Aggiorna la comanda prima di incassare.`,
            "Disponibilità cambiata"
          );
          return;
        }
        if (reconciliation.priceChanges.length > 0) {
          const details = reconciliation.priceChanges
            .map(change => `${change.name}: ${money(change.from)} → ${money(change.to)}`)
            .join("; ");
          await uiAlert(
            `${details}. Il totale passa da ${money(reconciliation.oldTotal)} a ${money(reconciliation.newTotal)}.`,
            "Prezzi aggiornati"
          );
        }
      } catch (err) {
        await uiError(err);
        return;
      } finally {
        renderCart();
      }
    }
    if (!checkoutAttempt) {
      if (cashReceivedEl) cashReceivedEl.value = "";
      setDiscount("none");
      setPayMethod("cash");
      refreshPayment();
    }
    setCheckoutControlsLocked(Boolean(checkoutAttempt));
    openModal(paymentModal);
    if (!checkoutAttempt) setTimeout(() => cashReceivedEl?.focus(), 0);
  });

  confirmPayBtn?.addEventListener("click", async () => {
    if (isPrinting) return;
    const total = payableTotal();
    if (!checkoutAttempt) {
      const body = {
        items: Array.from(cart.values()).map(it => ({
          product_id: it.product.id,
          qty: it.qty,
          expected_unit_price_cents: it.unit_price_cents,
          selected_option_value_ids: it.selected_option_value_ids,
          note: it.note,
        })),
        note: orderNoteEl?.value.trim() || null,
        payment_method: payMethod,
        discount: discountBody(),
      };
      if (payMethod === "cash") {
        if (total <= 0) {
          body.cash_received_cents = 0;
        } else {
          const received = eurToCents(cashReceivedEl?.value);
          if (received === null || received < total) return uiAlert("Contanti ricevuti insufficienti.");
          body.cash_received_cents = received;
        }
      }
      setCheckoutAttempt({
        requestId: newCheckoutRequestId(),
        payload: JSON.stringify(body),
      });
    }
    try {
      isPrinting = true;
      confirmPayBtn.disabled = true;
      const out = await api("/api/sales/print", {
        method: "POST",
        headers: { "Idempotency-Key": checkoutAttempt.requestId },
        body: checkoutAttempt.payload,
      });
      cart.clear();
      if (orderNoteEl) orderNoteEl.value = "";
      setCheckoutAttempt(null);
      setCheckoutControlsLocked(false);
      closeModal(paymentModal);
      cartCard?.classList.add("flash");
      setTimeout(() => cartCard?.classList.remove("flash"), 260);
      const restoMsg = out.change_cents != null && out.change_cents > 0 ? ` • resto ${money(out.change_cents)}` : "";
      showToast(`Ticket #${String(out.sale_number).padStart(4, "0")} • ${money(out.total_cents)}${restoMsg}`);
      await refreshSession();
      await refreshShellData();
      await reloadProducts();
    } catch (err) {
      if (err.data?.sale_recorded) {
        const saleNumber = String(err.data.sale_number || "").padStart(4, "0");
        cart.clear();
        if (orderNoteEl) orderNoteEl.value = "";
        setCheckoutAttempt(null);
        setCheckoutControlsLocked(false);
        closeModal(paymentModal);
        showToast(`Vendita #${saleNumber} registrata • stampa da ripetere`);
        await uiError(err);
        await refreshSession();
        await refreshShellData();
        await reloadProducts();
        return;
      }
      if (err.data?.code === "PRICE_CHANGED" || err.data?.code === "CATALOG_CHANGED") {
        setCheckoutAttempt(null);
        setCheckoutControlsLocked(false);
        try {
          await loadFreshProducts();
          const reconciliation = reconcileCartWithCatalog();
          renderCart();
          refreshPayment();
          await uiAlert(
            err.data.code === "PRICE_CHANGED"
              ? `Un prezzo è cambiato durante l'incasso. Il totale aggiornato è ${money(reconciliation.newTotal)}: verificalo prima di confermare di nuovo.`
              : `${err.message}. Verifica la comanda prima di confermare di nuovo.`,
            err.data.code === "PRICE_CHANGED" ? "Prezzo aggiornato" : "Catalogo aggiornato"
          );
        } catch (refreshError) {
          await uiError(refreshError);
        }
        return;
      }
      const uncertain = err.status === undefined || err.data?.retryable === true;
      if (uncertain) {
        setCheckoutControlsLocked(true);
        await uiAlert(
          `${err.message}\n\nEsito incerto: riapri l'incasso e premi di nuovo Conferma.`,
          "Verifica l'incasso",
          "danger"
        );
      } else {
        setCheckoutAttempt(null);
        setCheckoutControlsLocked(false);
        await uiError(err);
      }
    } finally {
      isPrinting = false;
      renderCart();
      refreshPayment();
    }
  });

  // chiusura generica delle modali (backdrop, pulsanti "Annulla", Esc)
  for (const modal of [openSessionModal, paymentModal, closeSessionModal, movementModal, suspendedCartsModal, itemOptionsModal]) {
    modal?.addEventListener("click", (e) => {
      if (e.target?.getAttribute?.("data-close-modal") === "1") closeModal(modal);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const top = topOpenModal();
    if ([openSessionModal, paymentModal, closeSessionModal, movementModal, suspendedCartsModal, itemOptionsModal].includes(top)) {
      closeModal(top);
    }
  }, { signal });

  clearBtn?.addEventListener("click", async () => {
    if (cart.size === 0) return;
    if (guardPendingCheckout()) return;
    const ok = await uiConfirm("Vuoi svuotare il carrello corrente?", "Svuota carrello");
    if (!ok) return;
    cart.clear();
    if (orderNoteEl) orderNoteEl.value = "";
    renderCart();
    showToast("Carrello svuotato");
  });

  mobileCartBar?.addEventListener("click", () => {
    cartCard?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  renderCategoryFilters();
  applySearch();
  renderCart();
  await refreshSession();
  checkoutAttempt = loadAttempt(CHECKOUT_ATTEMPT_KEY);
  movementAttempt = loadAttempt(MOVEMENT_ATTEMPT_KEY);
  suspendAttempt = loadAttempt(SUSPEND_ATTEMPT_KEY);
  resumeAttempt = loadAttempt(RESUME_ATTEMPT_KEY);
  const recovery = recoverCurrentCart();
  cartPersistenceReady = true;
  renderCart();
  restoreCheckoutUi();
  if (resumeAttempt && cart.size === 0) {
    try { await completeResumeAttempt(); } catch (err) { await uiError(err); }
  }
  if (checkoutAttempt) {
    setCheckoutControlsLocked(true);
    showToast("Incasso in sospeso recuperato");
  } else if (movementAttempt || suspendAttempt || resumeAttempt) {
    showToast("Operazione in sospeso recuperata");
  }
  if (recovery.recovered) showToast("Comanda recuperata");
  if (recovery.skipped.length > 0) {
    void uiAlert(
      `Alcuni articoli non sono stati recuperati o sono stati ridotti alla disponibilità attuale: ${recovery.skipped.join(", ")}.`,
      "Recupero parziale"
    );
  }
}
