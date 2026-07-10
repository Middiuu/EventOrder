// Config caricata da /api/config all'avvio (branding, valuta, locale)
let APP_CONFIG = {
  appName: "POS",
  businessName: "POS",
  tagline: "Cassa locale",
  currencySymbol: "€",
  locale: "it-IT",
};

function money(cents) {
  return APP_CONFIG.currencySymbol + " " + (cents / 100).toFixed(2).replace(".", ",");
}

// Alias retro-compatibile
function euro(cents) {
  return money(cents);
}

async function loadConfig() {
  try {
    const cfg = await api("/api/config");
    APP_CONFIG = { ...APP_CONFIG, ...cfg };
  } catch {
    // fallback ai default se l'endpoint non risponde
  }
}

function applyBranding() {
  const { appName, tagline } = APP_CONFIG;
  const brandEyebrow = document.querySelector(".brand-lockup .eyebrow");
  const brandMark = document.querySelector(".brand-mark");
  if (brandEyebrow) brandEyebrow.textContent = appName;
  if (brandMark) brandMark.textContent = (appName.trim()[0] || "P").toUpperCase();

  // Titolo pagina: "<AppName> — <sezione>" mantenendo la sezione esistente
  const parts = document.title.split(/\s*[-–—]\s*/);
  const section = parts.length > 1 ? parts.slice(1).join(" - ") : "";
  document.title = section ? `${appName} - ${section}` : appName;

  const taglineEl = document.querySelector("[data-app-tagline]");
  if (taglineEl && tagline) taglineEl.textContent = tagline;
}

// Firma visiva: un festone di luminarie sotto la topbar
function renderFestoon() {
  const topbar = document.querySelector(".topbar");
  if (!topbar || topbar.parentElement.querySelector(".festoon")) return;
  const festoon = document.createElement("div");
  festoon.className = "festoon";
  festoon.setAttribute("aria-hidden", "true");
  festoon.innerHTML = Array.from({ length: 22 }, () => "<i></i>").join("");
  topbar.insertAdjacentElement("afterend", festoon);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Errore");
  return data;
}

// --------------------
// Utils date (report export)
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDaysYmd(ymdStr, days) {
  const d = new Date(ymdStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return ymd(d);
}

let reportRevenueChart = null;
let reportMixChart = null;

// --------------------
// Helpers valuta / modali (condivisi)
function eurToCents(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function openModal(el) {
  if (!el) return;
  el.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeModal(el) {
  if (!el) return;
  el.hidden = true;
  document.body.style.overflow = "";
}

// --------------------
// CASSA
async function initCassa() {
  const grid = document.querySelector("#productsGrid");
  const cartEl = document.querySelector("#cart");
  const totalEl = document.querySelector("#total");
  const printBtn = document.querySelector("#printBtn");
  const clearBtn = document.querySelector("#clearBtn");
  const searchEl = document.querySelector("#search");
  const toastEl = document.querySelector("#toast");
  const cartCard = document.querySelector("#cartCard");
  const cartHelper = document.querySelector("#cartHelper");

  // Barra turno
  const sessionBar = document.querySelector("#sessionBar");
  const sessionDot = document.querySelector("#sessionDot");
  const sessionStatus = document.querySelector("#sessionStatus");
  const openSessionBtn = document.querySelector("#openSessionBtn");
  const closeSessionBtn = document.querySelector("#closeSessionBtn");
  const openSessionModal = document.querySelector("#openSessionModal");
  const openSessionForm = document.querySelector("#openSessionForm");
  const operatorField = document.querySelector("#operatorField");
  const operatorSelect = operatorField?.querySelector('select[name="operator"]');
  const closeSessionModal = document.querySelector("#closeSessionModal");
  const closeSessionForm = document.querySelector("#closeSessionForm");
  const closeSummary = document.querySelector("#closeSummary");
  const closeDifferenceEl = document.querySelector("#closeDifference");

  // Modale pagamento
  const paymentModal = document.querySelector("#paymentModal");
  const payTotalEl = document.querySelector("#payTotal");
  const cashPanel = document.querySelector("#cashPanel");
  const cashReceivedEl = document.querySelector("#cashReceived");
  const quickCashEl = document.querySelector("#quickCash");
  const payChangeEl = document.querySelector("#payChange");
  const confirmPayBtn = document.querySelector("#confirmPayBtn");
  const payMethodBtns = Array.from(document.querySelectorAll(".pay-method"));

  if (!grid) return;

  const products = await api("/api/products");
  let filtered = [...products];

  const cart = new Map();
  let isPrinting = false;
  let session = null;
  let payMethod = "cash";

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 1700);
  }

  function cartTotal() {
    let total = 0;
    for (const it of cart.values()) total += it.qty * it.product.price_cents;
    return total;
  }

  // ---- Turno di cassa
  function renderSession() {
    if (sessionBar) sessionBar.hidden = false;
    const open = Boolean(session);
    if (sessionDot) sessionDot.classList.toggle("is-open", open);
    if (sessionStatus) {
      sessionStatus.textContent = open
        ? `Cassa aperta${session.operator ? " • " + session.operator : ""} • incasso ${money(session.totals?.revenueCents || 0)}`
        : "Cassa chiusa — apri la cassa per iniziare a vendere";
    }
    if (openSessionBtn) openSessionBtn.hidden = open;
    if (closeSessionBtn) closeSessionBtn.hidden = !open;
    if (cartHelper) {
      cartHelper.textContent = open
        ? "La stampa registra la vendita e genera il ticket della comanda corrente."
        : "Apri la cassa (con il fondo iniziale) per abilitare la vendita.";
    }
  }

  async function refreshSession() {
    try {
      const data = await api("/api/sessions/current");
      session = data.session || null;
    } catch {
      session = null;
    }
    renderSession();
    renderCart();
  }

  function populateOperators() {
    const ops = (APP_CONFIG.operators || []);
    if (!operatorField || !operatorSelect) return;
    if (ops.length === 0) { operatorField.hidden = true; return; }
    operatorField.hidden = false;
    operatorSelect.innerHTML = ops.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
  }

  openSessionBtn?.addEventListener("click", () => {
    populateOperators();
    openModal(openSessionModal);
  });

  openSessionForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const floatCents = eurToCents(openSessionForm.float_eur.value || "0");
    if (floatCents === null) return alert("Fondo cassa non valido.");
    const operator = operatorSelect && !operatorField.hidden ? operatorSelect.value : undefined;
    try {
      await api("/api/sessions/open", {
        method: "POST",
        body: JSON.stringify({ opening_float_cents: floatCents, operator })
      });
      closeModal(openSessionModal);
      showToast("Cassa aperta");
      await refreshSession();
    } catch (err) {
      alert(err.message);
    }
  });

  function renderCloseSummary() {
    const t = session?.totals || {};
    const expected = t.expectedCashCents || 0;
    if (closeSummary) {
      closeSummary.innerHTML = `
        <div class="row"><div>Fondo cassa iniziale</div><div>${money(session?.opening_float_cents || 0)}</div></div>
        <div class="row"><div>Incasso contanti</div><div>${money((t.byMethod?.cash) || 0)}</div></div>
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
    renderCloseSummary();
    if (closeSessionForm) closeSessionForm.counted_eur.value = "";
    openModal(closeSessionModal);
  });
  closeSessionForm?.addEventListener("input", updateCloseDifference);
  closeSessionForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const counted = eurToCents(closeSessionForm.counted_eur.value);
    if (counted === null) return alert("Inserisci i contanti contati.");
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
      alert(err.message);
    }
  });

  function renderProducts() {
    grid.innerHTML = "";
    for (const p of filtered) {
      const b = document.createElement("button");
      b.className = "btn product-card";
      b.innerHTML = `
        <div class="product-card-title">${escapeHtml(p.name)}</div>
        <div class="product-card-meta">${escapeHtml(p.category)} • <span class="product-price">${euro(p.price_cents)}</span></div>
      `;
      b.onclick = () => addProduct(p);
      grid.appendChild(b);
    }
  }

  function renderCart() {
    cartEl.innerHTML = "";
    let total = 0;

    for (const [id, it] of cart.entries()) {
      const line = it.qty * it.product.price_cents;
      total += line;

      const row = document.createElement("div");
      row.className = "cart-item";
      row.innerHTML = `
        <div style="min-width: 0;">
          <div class="cart-item-title">
            <b>${it.qty}x</b> ${escapeHtml(it.product.name)}
          </div>
          <div class="small">${euro(it.product.price_cents)} cad.</div>
        </div>
        <div class="qtyBtns">
          <button class="qtyBtn" data-dec="${id}">-</button>
          <button class="qtyBtn" data-inc="${id}">+</button>
          <div class="line-total">${euro(line)}</div>
        </div>
      `;
      cartEl.appendChild(row);
    }

    totalEl.textContent = euro(total);

    const empty = cart.size === 0;
    if (printBtn) printBtn.disabled = empty || isPrinting || !session;
    if (clearBtn) clearBtn.disabled = empty || isPrinting;
  }

  function addProduct(p) {
    const cur = cart.get(p.id);
    cart.set(p.id, { product: p, qty: (cur?.qty || 0) + 1 });
    renderCart();
  }

  function decProduct(id) {
    const cur = cart.get(id);
    if (!cur) return;
    const next = cur.qty - 1;
    if (next <= 0) cart.delete(id);
    else cart.set(id, { ...cur, qty: next });
    renderCart();
  }

  function incProduct(id) {
    const cur = cart.get(id);
    if (!cur) return;
    cart.set(id, { ...cur, qty: cur.qty + 1 });
    renderCart();
  }

  cartEl.addEventListener("click", (e) => {
    const dec = e.target?.getAttribute?.("data-dec");
    const inc = e.target?.getAttribute?.("data-inc");
    if (dec) decProduct(Number(dec));
    if (inc) incProduct(Number(inc));
  });

  function applySearch() {
    const q = (searchEl?.value || "").trim().toLowerCase();
    if (!q) filtered = [...products];
    else filtered = products.filter(p =>
      (p.name + " " + p.category).toLowerCase().includes(q)
    );
    renderProducts();
  }
  searchEl?.addEventListener("input", applySearch);

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
    const sorted = [...values].filter(v => v >= total).sort((a, b) => a - b).slice(0, 5);
    quickCashEl.innerHTML = sorted.map(v =>
      `<button type="button" class="btn btn-secondary btn-compact quick-cash-btn" data-cash="${v}">${money(v)}</button>`
    ).join("");
  }

  function updatePayChange() {
    if (!payChangeEl) return;
    const total = cartTotal();
    if (payMethod !== "cash") {
      payChangeEl.textContent = money(0);
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
  cashReceivedEl?.addEventListener("input", updatePayChange);
  quickCashEl?.addEventListener("click", (e) => {
    const v = e.target?.getAttribute?.("data-cash");
    if (!v || !cashReceivedEl) return;
    cashReceivedEl.value = (Number(v) / 100).toFixed(2);
    updatePayChange();
  });

  printBtn?.addEventListener("click", () => {
    if (!session || cart.size === 0) return;
    const total = cartTotal();
    if (payTotalEl) payTotalEl.textContent = money(total);
    if (cashReceivedEl) cashReceivedEl.value = "";
    buildQuickCash(total);
    setPayMethod("cash");
    openModal(paymentModal);
    setTimeout(() => cashReceivedEl?.focus(), 0);
  });

  confirmPayBtn?.addEventListener("click", async () => {
    if (isPrinting) return;
    const total = cartTotal();
    const body = {
      items: Array.from(cart.values()).map(it => ({ product_id: it.product.id, qty: it.qty })),
      payment_method: payMethod,
    };
    if (payMethod === "cash") {
      const received = eurToCents(cashReceivedEl?.value);
      if (received === null || received < total) return alert("Contanti ricevuti insufficienti.");
      body.cash_received_cents = received;
    }
    try {
      isPrinting = true;
      confirmPayBtn.disabled = true;
      const out = await api("/api/sales/print", { method: "POST", body: JSON.stringify(body) });
      cart.clear();
      closeModal(paymentModal);
      cartCard?.classList.add("flash");
      setTimeout(() => cartCard?.classList.remove("flash"), 260);
      const restoMsg = out.change_cents != null && out.change_cents > 0 ? ` • resto ${money(out.change_cents)}` : "";
      showToast(`Ticket #${String(out.sale_number).padStart(4, "0")} • ${money(out.total_cents)}${restoMsg}`);
      await refreshSession();
    } catch (err) {
      alert(err.message);
    } finally {
      isPrinting = false;
      renderCart();
    }
  });

  // chiusura generica delle modali (backdrop, pulsanti "Annulla", Esc)
  for (const modal of [openSessionModal, paymentModal, closeSessionModal]) {
    modal?.addEventListener("click", (e) => {
      if (e.target?.getAttribute?.("data-close-modal") === "1") closeModal(modal);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    [openSessionModal, paymentModal, closeSessionModal].forEach(m => { if (m && !m.hidden) closeModal(m); });
  });

  clearBtn?.addEventListener("click", async () => {
    if (cart.size === 0) return;
    const ok = confirm("Svuotare il carrello?");
    if (!ok) return;
    cart.clear();
    renderCart();
    showToast("Carrello svuotato");
  });

  renderProducts();
  renderCart();
  await refreshSession();
}

// --------------------
// Prodotti / Report / Export
async function initProdotti() {
  const table = document.querySelector("#productsTable");
  const form = document.querySelector("#productForm");
  const newBtn = document.querySelector("#newProductBtn");
  const cancelCreateBtn = document.querySelector("#cancelEditBtn");
  const searchEl = document.querySelector("#productsSearch");
  const toastEl = document.querySelector("#toast");
  const modalEl = document.querySelector("#editProductModal");
  const editForm = document.querySelector("#editProductForm");
  const closeModalBtn = document.querySelector("#closeEditModalBtn");
  const cancelModalBtn = document.querySelector("#cancelEditModalBtn");

  if (!table || !form) return;

  const nameEl = form.querySelector('input[name="name"]');
  const categoryEl = form.querySelector('input[name="category"]');
  const priceEl = form.querySelector('input[name="price_eur"]');
  const sortEl = form.querySelector('input[name="sort_order"]');
  const activeEl = form.querySelector('input[name="active"]');
  const editIdEl = editForm?.querySelector('input[name="id"]');
  const editNameEl = editForm?.querySelector('input[name="name"]');
  const editCategoryEl = editForm?.querySelector('input[name="category"]');
  const editPriceEl = editForm?.querySelector('input[name="price_eur"]');
  const editSortEl = editForm?.querySelector('input[name="sort_order"]');
  const editActiveEl = editForm?.querySelector('input[name="active"]');

  let allRows = [];
  let filteredRows = [];
  let sortable = null;

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 1700);
  }

  function centsFromEuroInput(value) {
    const n = Number(String(value).replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  }

  function resetCreateForm() {
    form.reset();
    sortEl.value = "0";
    activeEl.checked = true;
    nameEl.focus();
  }

  function openEditModal(product) {
    if (!modalEl || !editForm) return;
    editIdEl.value = String(product.id);
    editNameEl.value = product.name ?? "";
    editCategoryEl.value = product.category ?? "Generale";
    editPriceEl.value = (Number(product.price_cents) / 100).toFixed(2);
    editSortEl.value = String(product.sort_order ?? 0);
    editActiveEl.checked = !!product.active;
    modalEl.hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(() => editNameEl.focus(), 0);
  }

  function closeEditModal() {
    if (!modalEl || !editForm) return;
    modalEl.hidden = true;
    editForm.reset();
    document.body.style.overflow = "";
  }

  function renderTable() {
    table.innerHTML = filteredRows.map(p => `
      <tr>
        <td data-label="Sposta"><span class="table-handle" aria-hidden="true">⋮⋮</span></td>
        <td data-label="Stato"><span class="status-pill ${p.active ? "is-active" : "is-inactive"}">${p.active ? "Attivo" : "Disattivo"}</span></td>
        <td data-label="Nome"><b>${escapeHtml(p.name)}</b></td>
        <td data-label="Categoria">${escapeHtml(p.category)}</td>
        <td data-label="Prezzo">${euro(p.price_cents)}</td>
        <td data-label="Azioni">
          <button class="btn btn-secondary btn-compact" data-edit="${p.id}" type="button">Modifica</button>
        </td>
      </tr>
    `).join("");

    syncSortableState();
  }

  function applySearch() {
    const q = (searchEl?.value || "").trim().toLowerCase();
    filteredRows = !q ? [...allRows] : allRows.filter(p => (`${p.name} ${p.category}`).toLowerCase().includes(q));
    renderTable();
  }

  function syncSortableState() {
    if (!window.Sortable || !table) return;

    if (!sortable) {
      sortable = window.Sortable.create(table, {
        animation: 180,
        handle: ".table-handle",
        ghostClass: "sortable-ghost",
        chosenClass: "sortable-chosen",
        onEnd: async (evt) => {
          if (evt.oldIndex === evt.newIndex) return;
          if ((searchEl?.value || "").trim()) {
            showToast("Svuota la ricerca per riordinare l'elenco.");
            await refresh();
            return;
          }

          const moved = filteredRows.splice(evt.oldIndex, 1)[0];
          filteredRows.splice(evt.newIndex, 0, moved);
          allRows = [...filteredRows];

          try {
            await api("/api/products/reorder", {
              method: "POST",
              body: JSON.stringify({ order: allRows.map(row => row.id) })
            });
            showToast("Ordine prodotti aggiornato");
            await refresh();
          } catch (err) {
            alert(err.message);
            await refresh();
          }
        }
      });
    }

    sortable.option("disabled", Boolean((searchEl?.value || "").trim()));
  }

  async function refresh() {
    allRows = await api("/api/products/all");
    filteredRows = [...allRows];
    applySearch();
  }

  table.addEventListener("click", (e) => {
    const id = e.target?.getAttribute?.("data-edit");
    if (!id) return;
    const p = allRows.find(x => String(x.id) === String(id));
    if (p) openEditModal(p);
  });

  newBtn?.addEventListener("click", resetCreateForm);
  cancelCreateBtn?.addEventListener("click", resetCreateForm);
  searchEl?.addEventListener("input", applySearch);
  closeModalBtn?.addEventListener("click", closeEditModal);
  cancelModalBtn?.addEventListener("click", closeEditModal);
  modalEl?.addEventListener("click", (e) => {
    if (e.target?.getAttribute?.("data-close-modal") === "1") {
      closeEditModal();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalEl && !modalEl.hidden) {
      closeEditModal();
    }
  });

  form.onsubmit = async (e) => {
    e.preventDefault();

    const name = String(nameEl.value || "").trim();
    const category = String(categoryEl.value || "Generale").trim() || "Generale";
    const price_cents = centsFromEuroInput(priceEl.value);
    const sort_order = Number(sortEl.value || 0);
    const active = activeEl.checked ? 1 : 0;

    if (!name) return alert("Inserisci un nome prodotto.");
    if (price_cents === null) return alert("Prezzo non valido.");

    try {
      await api("/api/products", { method: "POST", body: JSON.stringify({ name, category, price_cents, sort_order, active }) });
      showToast("Prodotto creato");
      await refresh();
      resetCreateForm();
    } catch (err) {
      alert(err.message);
    }
  };

  editForm.onsubmit = async (e) => {
    e.preventDefault();

    const id = String(editIdEl.value || "").trim();
    const name = String(editNameEl.value || "").trim();
    const category = String(editCategoryEl.value || "Generale").trim() || "Generale";
    const price_cents = centsFromEuroInput(editPriceEl.value);
    const sort_order = Number(editSortEl.value || 0);
    const active = editActiveEl.checked ? 1 : 0;

    if (!id) return alert("Prodotto non valido.");
    if (!name) return alert("Inserisci un nome prodotto.");
    if (price_cents === null) return alert("Prezzo non valido.");

    try {
      await api(`/api/products/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name, category, price_cents, sort_order, active })
      });
      showToast("Prodotto aggiornato");
      closeEditModal();
      await refresh();
      resetCreateForm();
    } catch (err) {
      alert(err.message);
    }
  };

  await refresh();
  resetCreateForm();
}

function destroyReportCharts() {
  reportRevenueChart?.destroy();
  reportMixChart?.destroy();
  reportRevenueChart = null;
  reportMixChart = null;
}

function renderReportCharts(byProduct) {
  destroyReportCharts();

  if (!window.Chart || byProduct.length === 0) return;

  const revenueCanvas = document.querySelector("#reportRevenueChart");
  const mixCanvas = document.querySelector("#reportMixChart");
  if (!revenueCanvas || !mixCanvas) return;

  const labels = byProduct.map((item) => item.name);
  const revenues = byProduct.map((item) => Number(item.revenue_cents) / 100);
  const qty = byProduct.map((item) => Number(item.qty_sold));
  // Palette "Festa serale": ambra, menta, corallo, blu, rosa luminaria
  const palette = ["#FFC24B", "#57D6A6", "#FF6F61", "#6AA6FF", "#FF8FB1", "#C6A2FF"];
  const ink = "#EDF0FA";
  const muted = "#94A0C6";
  const grid = "rgba(255,255,255,0.08)";
  const sym = APP_CONFIG.currencySymbol || "€";

  reportRevenueChart = new window.Chart(revenueCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Incasso",
        data: revenues,
        borderRadius: 10,
        backgroundColor: palette,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { color: muted, callback: (value) => `${sym} ${value}` },
          grid: { color: grid }
        },
        x: {
          ticks: { color: muted },
          grid: { display: false }
        }
      }
    }
  });

  reportMixChart = new window.Chart(mixCanvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        label: "Quantita'",
        data: qty,
        backgroundColor: palette,
        borderColor: "#0E1730",
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: ink, padding: 14 } }
      },
      cutout: "62%"
    }
  });
}

async function initReport() {
  const box = document.querySelector("#reportBox");
  if (!box) return;

  const data = await api("/api/reports/today");
  const s = data.summary;

  const lines = data.byProduct.map(p => `
    <div class="row">
      <div>
        <b>${escapeHtml(p.name)}</b>
        <div class="small">${p.qty_sold} venduti</div>
      </div>
      <div>${euro(p.revenue_cents)}</div>
    </div>
  `).join("");

  const PAY_LABEL = { cash: "Contanti", card: "Carta", other: "Altro" };
  const payLines = (data.byPayment || []).map(p => `
    <div class="row">
      <div><b>${escapeHtml(PAY_LABEL[p.payment_method] || p.payment_method)}</b>
        <div class="small">${p.count} vendite</div>
      </div>
      <div>${euro(p.revenue_cents)}</div>
    </div>
  `).join("");

  box.innerHTML = `
    <div class="report-grid">
      <section class="surface-card metric-card">
        <div class="eyebrow">Oggi</div>
        <h2>Incasso del giorno</h2>
        <div class="small">${s.sales_count} vendite registrate</div>
        <div class="metric-value">${euro(s.revenue_cents)}</div>
        <div class="report-list report-list-tight">${payLines || ""}</div>
      </section>
      <section class="surface-card">
        <div class="section-heading section-heading-tight">
          <div>
            <div class="eyebrow">Dettaglio</div>
            <h2>Venduto per prodotto</h2>
          </div>
        </div>
        <div class="report-list">${lines || "<div class='empty-state'>Nessuna vendita registrata oggi.</div>"}</div>
      </section>
    </div>
    <div class="chart-panel">
      <section class="surface-card chart-card">
        <div class="section-heading section-heading-tight">
          <div>
            <div class="eyebrow">Andamento</div>
            <h2>Incasso per prodotto</h2>
          </div>
        </div>
        <div class="chart-wrap">
          <canvas id="reportRevenueChart" aria-label="Grafico incasso per prodotto"></canvas>
        </div>
      </section>
      <section class="surface-card chart-card">
        <div class="section-heading section-heading-tight">
          <div>
            <div class="eyebrow">Mix vendita</div>
            <h2>Distribuzione quantita'</h2>
          </div>
        </div>
        <div class="chart-wrap">
          <canvas id="reportMixChart" aria-label="Grafico distribuzione quantita' vendute"></canvas>
        </div>
      </section>
    </div>
  `;

  renderReportCharts(data.byProduct);
}

async function initReportExport() {
  const fromEl = document.querySelector("#fromDate");
  const toEl = document.querySelector("#toDate");
  const btn = document.querySelector("#downloadCsvBtn");
  const txBtn = document.querySelector("#downloadTxCsvBtn");
  const toastEl = document.querySelector("#toast");
  if (!fromEl || !toEl || !btn) return;

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 1700);
  }

  const today = ymd(new Date());
  fromEl.value = today;
  toEl.value = today;

  function rangeUrl(endpoint) {
    const from = (fromEl.value || "").trim();
    const toInclusive = (toEl.value || "").trim();
    if (!from || !toInclusive) { alert("Seleziona entrambe le date (Da / A)."); return null; }
    const toExclusive = addDaysYmd(toInclusive, 1);
    return { url: `${endpoint}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(toExclusive)}`, from, toInclusive };
  }

  btn.onclick = () => {
    const r = rangeUrl("/api/reports/export.csv");
    if (!r) return;
    showToast(`CSV prodotti: ${r.from} → ${r.toInclusive}`);
    window.location.href = r.url;
  };

  if (txBtn) txBtn.onclick = () => {
    const r = rangeUrl("/api/reports/transactions.csv");
    if (!r) return;
    showToast(`CSV transazioni: ${r.from} → ${r.toInclusive}`);
    window.location.href = r.url;
  };
}

// --------------------
// VENDITE (storico + storni)
async function initSales() {
  const listEl = document.querySelector("#salesList");
  const refreshBtn = document.querySelector("#refreshSalesBtn");
  const toastEl = document.querySelector("#toast");
  if (!listEl) return;

  const PAY_LABEL = { cash: "Contanti", card: "Carta", other: "Altro" };

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 1700);
  }

  function saleCard(sale) {
    const items = (sale.items || []).map(it => `${it.qty}× ${escapeHtml(it.name)}`).join(", ");
    const when = new Date(sale.created_at + "Z").toLocaleString(APP_CONFIG.locale);
    const num = String(sale.sale_number).padStart(4, "0");
    return `
      <div class="surface-card sale-row ${sale.voided ? "is-voided" : ""}">
        <div class="sale-main">
          <div class="sale-head">
            <b>#${num}</b>
            <span class="status-pill ${sale.voided ? "is-inactive" : "is-active"}">${sale.voided ? "Annullata" : PAY_LABEL[sale.payment_method] || sale.payment_method}</span>
            ${sale.operator ? `<span class="small">${escapeHtml(sale.operator)}</span>` : ""}
          </div>
          <div class="small">${when}</div>
          <div class="small sale-items">${items || "—"}</div>
          ${sale.voided && sale.void_reason ? `<div class="small sale-void-reason">Motivo: ${escapeHtml(sale.void_reason)}</div>` : ""}
        </div>
        <div class="sale-side">
          <div class="line-total">${euro(sale.total_cents)}</div>
          ${sale.voided ? "" : `<button class="btn btn-secondary btn-compact" data-void="${sale.id}" type="button">Annulla</button>`}
        </div>
      </div>
    `;
  }

  async function refresh() {
    const sales = await api("/api/sales?limit=100");
    listEl.innerHTML = sales.length
      ? sales.map(saleCard).join("")
      : "<div class='empty-state'>Nessuna vendita registrata.</div>";
  }

  listEl.addEventListener("click", async (e) => {
    const id = e.target?.getAttribute?.("data-void");
    if (!id) return;
    const reason = prompt("Motivo dell'annullo:", "");
    if (reason === null) return;
    try {
      await api(`/api/sales/${encodeURIComponent(id)}/void`, {
        method: "POST",
        body: JSON.stringify({ reason })
      });
      showToast("Vendita annullata");
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  });

  refreshBtn?.addEventListener("click", refresh);
  await refresh();
}

// --------------------
document.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadConfig();
    applyBranding();
    renderFestoon();
    await initCassa();
    await initProdotti();
    await initSales();
    await initReport();
    await initReportExport();
  } catch (e) {
    console.error(e);
    alert(e.message || String(e));
  }
});
