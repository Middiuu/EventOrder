// Config caricata da /api/config all'avvio (branding, valuta, locale)
let APP_CONFIG = {
  appName: "EventOrder",
  businessName: "EventOrder",
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
  // Solo il titolo della pagina; il branding visibile è nella sidebar.
  const appName = APP_CONFIG.appName || "EventOrder";
  const parts = document.title.split(/\s*[-–—]\s*/);
  const section = parts.length > 1 ? parts.slice(1).join(" - ") : "";
  document.title = section ? `${appName} - ${section}` : appName;
}

// Tema chiaro/scuro: default scuro, override salvato via toggle
function effectiveTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function toggleTheme() {
  const next = effectiveTheme() === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("eo-theme", next); } catch {}
  syncThemeToggle();
  // ridisegna i grafici del report con i colori del nuovo tema
  if (document.querySelector("#reportBox") && typeof initReport === "function") {
    initReport().catch(() => {});
  }
}

function syncThemeToggle() {
  const btn = document.querySelector(".theme-toggle");
  if (!btn) return;
  const isLight = effectiveTheme() === "light";
  btn.textContent = isLight ? "🌙" : "☀️";
  const label = isLight ? "Passa al tema scuro" : "Passa al tema chiaro";
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

const NAV_ITEMS = [
  { page: "cassa", href: "/cassa.html", label: "Cassa" },
  { page: "prodotti", href: "/products.html", label: "Prodotti", count: "prodotti" },
  { page: "vendite", href: "/sales.html", label: "Vendite", count: "vendite" },
  { page: "report", href: "/reports.html", label: "Report" },
];

// Costruisce la sidebar (brand, nav, card turno, operatore, toggle tema)
function renderSidebar(active) {
  const app = document.querySelector("#app");
  if (!app || app.querySelector(".sidebar")) return;
  const appName = APP_CONFIG.appName || "EventOrder";
  const title = APP_CONFIG.businessName || appName;
  const mark = (appName.trim()[0] || "E").toUpperCase();

  const nav = NAV_ITEMS.map(it => `
    <a href="${it.href}" class="${it.page === active ? "is-active" : ""}">
      <span>${escapeHtml(it.label)}</span>
      ${it.count ? `<span class="count" data-count="${it.count}"></span>` : ""}
    </a>`).join("");

  const aside = document.createElement("aside");
  aside.className = "sidebar";
  aside.innerHTML = `
    <div class="brand brand-lockup">
      <div class="brand-mark">${escapeHtml(mark)}</div>
      <div>
        <div class="brand-title">${escapeHtml(title)}</div>
        <div class="brand-sub">EventOrder</div>
      </div>
    </div>
    <div class="side-label">Menu</div>
    <nav class="side-nav" aria-label="Navigazione">${nav}</nav>
    <div class="side-spacer"></div>
    <div class="session-card" id="sessionCard" hidden>
      <div class="s-title"><span class="dot"></span><span id="sessionCardTitle">Cassa chiusa</span></div>
      <div class="s-label">Incasso del turno</div>
      <div class="s-value" id="sessionCardValue">€ 0,00</div>
    </div>
    <div class="side-foot">
      <div class="avatar" id="sideAvatar">E</div>
      <div class="who"><span id="sideOperator">Operatore</span><small id="sideRole">EventOrder</small></div>
      <button class="logout-button" type="button" id="logoutButton" aria-label="Esci" title="Esci" hidden>↪</button>
      <button class="theme-toggle" type="button" id="themeToggle"></button>
    </div>`;
  app.insertBefore(aside, app.firstChild);

  aside.querySelector("#themeToggle").addEventListener("click", toggleTheme);
  aside.querySelector("#logoutButton").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    location.replace("/login.html");
  });
  syncThemeToggle();
}

function syncAuthControls() {
  const logoutButton = document.querySelector("#logoutButton");
  if (logoutButton) logoutButton.hidden = !APP_CONFIG.authRequired;
}

// Aggiorna nome/marchio nella sidebar dopo il caricamento della config
function refreshBrand() {
  const appName = APP_CONFIG.appName || "EventOrder";
  const mark = document.querySelector(".sidebar .brand-mark");
  const title = document.querySelector(".sidebar .brand-title");
  if (mark) mark.textContent = (appName.trim()[0] || "E").toUpperCase();
  if (title) title.textContent = APP_CONFIG.businessName || appName;
}

// Aggiorna la card turno nella sidebar (chiamata da più pagine)
function updateSessionCard(session) {
  const card = document.querySelector("#sessionCard");
  if (!card) return;
  card.hidden = false;
  const open = Boolean(session);
  card.classList.toggle("is-open", open);
  const title = card.querySelector("#sessionCardTitle");
  const value = card.querySelector("#sessionCardValue");
  if (title) title.textContent = open ? "Cassa aperta" : "Cassa chiusa";
  if (value) value.textContent = money(session?.totals?.revenueCents || 0);
  const op = document.querySelector("#sideOperator");
  const avatar = document.querySelector("#sideAvatar");
  if (op) op.textContent = session?.operator || "Operatore";
  if (avatar) avatar.textContent = ((session?.operator || APP_CONFIG.appName || "E").trim()[0] || "E").toUpperCase();
}

// Carica dati per la shell (turno + conteggi nav), best-effort
async function refreshShellData() {
  try {
    const data = await api("/api/sessions/current");
    updateSessionCard(data.session || null);
  } catch { updateSessionCard(null); }
  try {
    const setCount = (k, v) => { const el = document.querySelector(`[data-count="${k}"]`); if (el) el.textContent = v; };
    const products = await api("/api/products/all");
    setCount("prodotti", products.filter(p => p.active).length);
    const sales = await api("/api/sales?limit=500");
    setCount("vendite", sales.filter(s => !s.voided).length);
  } catch {}
}

// ---- Navigazione client-side: niente reload/flash tra le sezioni
const APP_PAGES = new Set(["/cassa.html", "/products.html", "/sales.html", "/reports.html"]);

function ensureScript(src) {
  return new Promise((resolve) => {
    if ([...document.scripts].some(s => s.src.includes(src))) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => resolve();
    document.body.appendChild(el);
  });
}

let pageInitController = null;

async function runPageInits() {
  pageInitController?.abort();
  pageInitController = new AbortController();
  const { signal } = pageInitController;
  try {
    await initCassa(signal);
    await initProdotti(signal);
    await initSales();
    await initReport();
    await initReportExport();
  } catch (e) {
    console.error(e);
  }
}

function setActiveNav(url) {
  document.querySelectorAll(".side-nav a").forEach(a => {
    a.classList.toggle("is-active", a.getAttribute("href") === url);
  });
}

async function clientNavigate(url, push = true) {
  let html;
  try { html = await (await fetch(url)).text(); }
  catch { location.href = url; return; }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const newMain = doc.querySelector(".main");
  const curMain = document.querySelector(".main");
  if (!newMain || !curMain) { location.href = url; return; }

  curMain.replaceWith(newMain);
  document.title = doc.title || document.title;
  document.body.dataset.page = doc.body.dataset.page || "";
  setActiveNav(url);
  if (push) history.pushState({ eo: true }, "", url);
  window.scrollTo(0, 0);

  const page = document.body.dataset.page;
  if (page === "prodotti") await ensureScript("/vendor/sortablejs/Sortable.min.js");
  if (page === "report") await ensureScript("/vendor/chart.js/dist/chart.umd.min.js");
  await runPageInits();
  await refreshShellData();
}

function initRouter() {
  document.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const a = e.target.closest?.("a");
    const href = a?.getAttribute("href");
    if (!a || !href || !APP_PAGES.has(href) || a.target === "_blank") return;
    e.preventDefault();
    if (href === location.pathname) return; // già qui: nessun reload
    clientNavigate(href, true);
  });
  window.addEventListener("popstate", () => {
    if (APP_PAGES.has(location.pathname)) clientNavigate(location.pathname, false);
  });
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
  const { headers = {}, ...rest } = opts || {};
  const res = await fetch(path, {
    ...rest,
    headers: { "Content-Type": "application/json", ...headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Errore");
    err.status = res.status;
    err.data = data;
    throw err;
  }
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
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const n = Number(raw.replace(",", "."));
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

// Dialog a tema (sostituisce i nativi confirm/prompt, non ottimizzati per il touch)
function ensureDialog() {
  let el = document.querySelector("#appDialog");
  if (el) return el;
  el = document.createElement("div");
  el.id = "appDialog";
  el.className = "modal-shell";
  el.hidden = true;
  el.innerHTML = `
    <div class="modal-backdrop" data-dlg="cancel"></div>
    <div class="modal-card dialog-card" role="dialog" aria-modal="true" aria-labelledby="appDialogTitle">
      <h2 id="appDialogTitle" class="dialog-title"></h2>
      <p class="dialog-message"></p>
      <label class="field dialog-input-field" hidden>
        <span class="field-label dialog-input-label"></span>
        <input class="input dialog-input" type="text" />
      </label>
      <div class="actions">
        <button class="btn btn-primary dialog-ok" type="button">Conferma</button>
        <button class="btn btn-secondary" type="button" data-dlg="cancel">Annulla</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  return el;
}

function openDialog({ title, message, input, okLabel } = {}) {
  return new Promise((resolve) => {
    const el = ensureDialog();
    el.querySelector(".dialog-title").textContent = title || "";
    const msgEl = el.querySelector(".dialog-message");
    msgEl.textContent = message || "";
    msgEl.hidden = !message;
    const field = el.querySelector(".dialog-input-field");
    const inputEl = el.querySelector(".dialog-input");
    if (input) {
      field.hidden = false;
      el.querySelector(".dialog-input-label").textContent = input.label || "";
      inputEl.value = input.value || "";
    } else {
      field.hidden = true;
    }
    const ok = el.querySelector(".dialog-ok");
    ok.textContent = okLabel || "Conferma";
    openModal(el);

    function cleanup(result) {
      closeModal(el);
      ok.removeEventListener("click", onOk);
      el.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    const onOk = () => cleanup(input ? inputEl.value : true);
    const onCancel = (e) => { if (e.target?.getAttribute?.("data-dlg") === "cancel") cleanup(input ? null : false); };
    const onKey = (e) => {
      if (e.key === "Escape") cleanup(input ? null : false);
      else if (e.key === "Enter") { e.preventDefault(); onOk(); }
    };
    ok.addEventListener("click", onOk);
    el.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
    setTimeout(() => (input ? inputEl : ok).focus(), 0);
  });
}

const uiConfirm = (message, title = "Conferma") => openDialog({ title, message });
const uiPrompt = (title, label, value = "") => openDialog({ title, input: { label, value } });

// --------------------
// CASSA
async function initCassa(signal) {
  const grid = document.querySelector("#productsGrid");
  const cartEl = document.querySelector("#cart");
  const totalEl = document.querySelector("#total");
  const printBtn = document.querySelector("#printBtn");
  const clearBtn = document.querySelector("#clearBtn");
  const searchEl = document.querySelector("#search");
  const toastEl = document.querySelector("#toast");
  const cartCard = document.querySelector("#cartCard");
  const cartHelper = document.querySelector("#cartHelper");
  const mobileCartBar = document.querySelector("#mobileCartBar");
  const mobileCartCount = document.querySelector("#mobileCartCount");
  const mobileCartTotal = document.querySelector("#mobileCartTotal");

  // Barra turno
  const sessionBar = document.querySelector("#sessionBar");
  const sessionDot = document.querySelector("#sessionDot");
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

  function newCheckoutRequestId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `eo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  // Ricarica il catalogo (scorte e stato esaurito cambiano durante il servizio)
  async function reloadProducts() {
    try {
      products = await api("/api/products");
    } catch {
      // in caso di errore si continua con l'elenco già caricato
    }
    applySearch();
  }

  const cart = new Map();
  let isPrinting = false;
  // Un tentativo dall'esito incerto conserva chiave e payload esatti: riaprire
  // la modale non puo' trasformare un retry in una seconda vendita.
  let checkoutAttempt = null;
  let session = null;
  let payMethod = "cash";
  let discType = "none"; // none | percent | amount | gift
  let movDirection = "out"; // out = prelievo | in = versamento

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 1700);
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
    for (const it of cart.values()) total += it.qty * it.product.price_cents;
    return total;
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
    } catch {
      session = null;
    }
    renderSession();
    renderCart();
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
    if (floatCents === null) return alert("Fondo cassa non valido.");
    const operator = operatorInput && !operatorField.hidden
      ? String(operatorInput.value || "").trim() || undefined
      : undefined;
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
    if (closeSessionForm) closeSessionForm.counted_eur.value = "";
    renderCloseSummary();
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
    movementForm?.reset();
    setMovementDirection("out");
    openModal(movementModal);
    setTimeout(() => movementForm?.amount_eur.focus(), 0);
  });
  movDirBtns.forEach(b => b.addEventListener("click", () => setMovementDirection(b.getAttribute("data-dir"))));
  movementForm?.addEventListener("input", updateMovementExpected);
  movementForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = eurToCents(movementForm.amount_eur.value);
    if (!amount) return alert("Inserisci un importo maggiore di zero.");
    const reason = String(movementForm.reason.value || "").trim();
    if (!reason) return alert("Indica il motivo del movimento.");
    try {
      await api("/api/sessions/movements", {
        method: "POST",
        body: JSON.stringify({ direction: movDirection, amount_cents: amount, reason }),
      });
      closeModal(movementModal);
      showToast(`${movDirection === "out" ? "Prelievo" : "Versamento"} registrato • ${money(amount)}`);
      await refreshSession();
    } catch (err) {
      alert(err.message);
    }
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
      alert(err.message);
    }
  }

  function renderProducts() {
    grid.innerHTML = "";
    for (const p of filtered) {
      const available = productAvailable(p);
      const b = document.createElement("button");
      b.className = "btn product-card" + (available ? "" : " is-soldout");

      let stockTag = "";
      if (available && p.stock != null) {
        stockTag = ` • <span class="stock-tag${p.stock <= 5 ? " low" : ""}">${p.stock} rimasti</span>`;
      }
      b.innerHTML = `
        <div class="product-card-title">${escapeHtml(p.name)}${available ? "" : ' <span class="soldout-tag">Esaurito</span>'}</div>
        <div class="product-card-meta">${escapeHtml(p.category)} • <span class="product-price">${euro(p.price_cents)}</span>${stockTag}</div>
      `;

      // Long-press su una card disponibile: segna il prodotto come esaurito.
      let pressTimer = null;
      let suppressClick = false;
      b.addEventListener("pointerdown", () => {
        suppressClick = false;
        if (!available) return;
        pressTimer = setTimeout(async () => {
          suppressClick = true;
          const ok = await uiConfirm(`Segnare "${p.name}" come esaurito? Non sarà più vendibile finché non lo rimetti disponibile.`, "Esaurito");
          if (ok) await setSoldOut(p, true);
        }, 650);
      });
      const cancelPress = () => clearTimeout(pressTimer);
      b.addEventListener("pointerup", cancelPress);
      b.addEventListener("pointerleave", cancelPress);
      b.addEventListener("pointercancel", cancelPress);
      b.addEventListener("contextmenu", (e) => e.preventDefault());

      b.onclick = async () => {
        if (suppressClick) { suppressClick = false; return; }
        if (available) return addProduct(p);
        if (p.sold_out) {
          const ok = await uiConfirm(`Rimettere "${p.name}" disponibile in cassa?`, "Di nuovo disponibile");
          if (ok) await setSoldOut(p, false);
        } else {
          alert("Scorte terminate: aggiornale dalla pagina Prodotti.");
        }
      };
      grid.appendChild(b);
    }
  }

  function renderCart() {
    cartEl.innerHTML = "";
    let total = 0;
    let itemCount = 0;

    for (const [id, it] of cart.entries()) {
      const line = it.qty * it.product.price_cents;
      total += line;
      itemCount += it.qty;

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
    if (mobileCartTotal) mobileCartTotal.textContent = euro(total);
    if (mobileCartCount) {
      mobileCartCount.textContent = itemCount === 0
        ? "Comanda vuota"
        : `${itemCount} ${itemCount === 1 ? "articolo" : "articoli"} nella comanda`;
    }

    const empty = cart.size === 0;
    if (printBtn) printBtn.disabled = empty || isPrinting || !session;
    if (clearBtn) clearBtn.disabled = empty || isPrinting;
    if (mobileCartBar) {
      mobileCartBar.disabled = empty;
      mobileCartBar.setAttribute("aria-label", empty ? "Comanda vuota" : `Vedi la comanda, totale ${euro(total)}`);
    }
  }

  function addProduct(p) {
    if (guardPendingCheckout()) return;
    const cur = cart.get(p.id);
    const nextQty = (cur?.qty || 0) + 1;
    if (p.stock != null && nextQty > p.stock) {
      showToast(`Disponibili solo ${p.stock} di "${p.name}"`);
      return;
    }
    cart.set(p.id, { product: p, qty: nextQty });
    renderCart();
  }

  function decProduct(id) {
    if (guardPendingCheckout()) return;
    const cur = cart.get(id);
    if (!cur) return;
    const next = cur.qty - 1;
    if (next <= 0) cart.delete(id);
    else cart.set(id, { ...cur, qty: next });
    renderCart();
  }

  function incProduct(id) {
    if (guardPendingCheckout()) return;
    const cur = cart.get(id);
    if (!cur) return;
    const p = cur.product;
    if (p.stock != null && cur.qty + 1 > p.stock) {
      showToast(`Disponibili solo ${p.stock} di "${p.name}"`);
      return;
    }
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

  printBtn?.addEventListener("click", () => {
    if (!session || cart.size === 0) return;
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
        items: Array.from(cart.values()).map(it => ({ product_id: it.product.id, qty: it.qty })),
        payment_method: payMethod,
        discount: discountBody(),
      };
      if (payMethod === "cash") {
        if (total <= 0) {
          body.cash_received_cents = 0;
        } else {
          const received = eurToCents(cashReceivedEl?.value);
          if (received === null || received < total) return alert("Contanti ricevuti insufficienti.");
          body.cash_received_cents = received;
        }
      }
      checkoutAttempt = {
        requestId: newCheckoutRequestId(),
        payload: JSON.stringify(body),
      };
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
      checkoutAttempt = null;
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
        checkoutAttempt = null;
        setCheckoutControlsLocked(false);
        closeModal(paymentModal);
        showToast(`Vendita #${saleNumber} registrata • stampa da ripetere`);
        alert(err.message);
        await refreshSession();
        await refreshShellData();
        await reloadProducts();
        return;
      }
      const uncertain = err.status === undefined || err.data?.retryable === true;
      if (uncertain) {
        setCheckoutControlsLocked(true);
        alert(`${err.message}\n\nEsito incerto: riapri l'incasso e premi di nuovo Conferma.`);
      } else {
        checkoutAttempt = null;
        setCheckoutControlsLocked(false);
        alert(err.message);
      }
    } finally {
      isPrinting = false;
      renderCart();
      refreshPayment();
    }
  });

  // chiusura generica delle modali (backdrop, pulsanti "Annulla", Esc)
  for (const modal of [openSessionModal, paymentModal, closeSessionModal, movementModal]) {
    modal?.addEventListener("click", (e) => {
      if (e.target?.getAttribute?.("data-close-modal") === "1") closeModal(modal);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    [openSessionModal, paymentModal, closeSessionModal, movementModal].forEach(m => { if (m && !m.hidden) closeModal(m); });
  }, { signal });

  clearBtn?.addEventListener("click", async () => {
    if (cart.size === 0) return;
    if (guardPendingCheckout()) return;
    const ok = await uiConfirm("Vuoi svuotare il carrello corrente?", "Svuota carrello");
    if (!ok) return;
    cart.clear();
    renderCart();
    showToast("Carrello svuotato");
  });

  mobileCartBar?.addEventListener("click", () => {
    cartCard?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  renderProducts();
  renderCart();
  await refreshSession();
}

// --------------------
// Prodotti / Report / Export
async function initProdotti(signal) {
  const table = document.querySelector("#productsTable");
  const form = document.querySelector("#productForm");
  const createCard = document.querySelector("#productCreateCard");
  const newBtn = document.querySelector("#newProductBtn");
  const cancelCreateBtn = document.querySelector("#cancelEditBtn");
  const searchEl = document.querySelector("#productsSearch");
  const toastEl = document.querySelector("#toast");
  const modalEl = document.querySelector("#editProductModal");
  const editForm = document.querySelector("#editProductForm");
  const closeModalBtn = document.querySelector("#closeEditModalBtn");
  const cancelModalBtn = document.querySelector("#cancelEditModalBtn");
  const deleteBtn = document.querySelector("#deleteProductBtn");

  if (!table || !form) return;

  const nameEl = form.querySelector('input[name="name"]');
  const categoryEl = form.querySelector('input[name="category"]');
  const priceEl = form.querySelector('input[name="price_eur"]');
  const sortEl = form.querySelector('input[name="sort_order"]');
  const activeEl = form.querySelector('input[name="active"]');
  const stockEl = form.querySelector('input[name="stock"]');
  const costEl = form.querySelector('input[name="cost_eur"]');
  const editIdEl = editForm?.querySelector('input[name="id"]');
  const editNameEl = editForm?.querySelector('input[name="name"]');
  const editCategoryEl = editForm?.querySelector('input[name="category"]');
  const editPriceEl = editForm?.querySelector('input[name="price_eur"]');
  const editSortEl = editForm?.querySelector('input[name="sort_order"]');
  const editActiveEl = editForm?.querySelector('input[name="active"]');
  const editStockEl = editForm?.querySelector('input[name="stock"]');
  const editCostEl = editForm?.querySelector('input[name="cost_eur"]');
  const editSoldOutEl = editForm?.querySelector('input[name="sold_out"]');

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

  // Scorte dal form: "" = non tracciate (null), altrimenti intero >= 0.
  // Ritorna undefined se il valore non è valido.
  function stockFromInput(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return undefined;
    return n;
  }

  // Costo dal form: "" = non tracciato (null), altrimenti euro -> centesimi.
  // Ritorna undefined se il valore non è valido.
  function costFromInput(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const cents = centsFromEuroInput(raw);
    if (cents === null) return undefined;
    return cents;
  }

  function resetCreateForm() {
    form.reset();
    sortEl.value = "0";
    activeEl.checked = true;
  }

  function openCreateForm() {
    resetCreateForm();
    if (createCard) createCard.hidden = false;
    createCard?.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => nameEl.focus(), 0);
  }

  function closeCreateForm() {
    resetCreateForm();
    if (createCard) createCard.hidden = true;
  }

  function openEditModal(product) {
    if (!modalEl || !editForm) return;
    editIdEl.value = String(product.id);
    editNameEl.value = product.name ?? "";
    editCategoryEl.value = product.category ?? "Generale";
    editPriceEl.value = (Number(product.price_cents) / 100).toFixed(2);
    editSortEl.value = String(product.sort_order ?? 0);
    editActiveEl.checked = !!product.active;
    if (editStockEl) editStockEl.value = product.stock == null ? "" : String(product.stock);
    if (editCostEl) editCostEl.value = product.cost_cents == null ? "" : (Number(product.cost_cents) / 100).toFixed(2);
    if (editSoldOutEl) editSoldOutEl.checked = !!product.sold_out;
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

  function statusPill(p) {
    if (!p.active) return '<span class="status-pill is-inactive">Disattivo</span>';
    if (p.sold_out || (p.stock != null && p.stock <= 0)) {
      return '<span class="status-pill is-soldout">Esaurito</span>';
    }
    return '<span class="status-pill is-active">Attivo</span>';
  }

  function renderTable() {
    table.innerHTML = filteredRows.map(p => `
      <tr>
        <td data-label="Sposta"><span class="table-handle" aria-hidden="true">⋮⋮</span></td>
        <td data-label="Stato">${statusPill(p)}</td>
        <td data-label="Nome"><b>${escapeHtml(p.name)}</b></td>
        <td data-label="Categoria">${escapeHtml(p.category)}</td>
        <td data-label="Prezzo">${euro(p.price_cents)}</td>
        <td data-label="Scorte">${p.stock == null ? "—" : p.stock}</td>
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
        // Touch: piccola pressione prima di trascinare, così lo scroll col dito
        // non fa partire un riordino accidentale (col mouse resta immediato).
        delay: 140,
        delayOnTouchOnly: true,
        touchStartThreshold: 6,
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

  newBtn?.addEventListener("click", openCreateForm);
  cancelCreateBtn?.addEventListener("click", closeCreateForm);
  deleteBtn?.addEventListener("click", async () => {
    const id = String(editIdEl?.value || "").trim();
    if (!id) return;
    const p = allRows.find(x => String(x.id) === id);
    const ok = await uiConfirm(
      `Eliminare definitivamente "${p ? p.name : "questo prodotto"}"? L'operazione non si può annullare.`,
      "Elimina prodotto"
    );
    if (!ok) return;
    try {
      await api(`/api/products/${encodeURIComponent(id)}`, { method: "DELETE" });
      showToast("Prodotto eliminato");
      closeEditModal();
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  });
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
  }, { signal });

  form.onsubmit = async (e) => {
    e.preventDefault();

    const name = String(nameEl.value || "").trim();
    const category = String(categoryEl.value || "Generale").trim() || "Generale";
    const price_cents = centsFromEuroInput(priceEl.value);
    const sort_order = Number(sortEl.value || 0);
    const active = activeEl.checked ? 1 : 0;
    const stock = stockFromInput(stockEl?.value);
    const cost_cents = costFromInput(costEl?.value);

    if (!name) return alert("Inserisci un nome prodotto.");
    if (price_cents === null) return alert("Prezzo non valido.");
    if (stock === undefined) return alert("Scorte non valide: intero >= 0 o vuoto.");
    if (cost_cents === undefined) return alert("Costo non valido: importo in euro o vuoto.");

    try {
      await api("/api/products", { method: "POST", body: JSON.stringify({ name, category, price_cents, sort_order, active, stock, cost_cents }) });
      showToast("Prodotto creato");
      await refresh();
      closeCreateForm();
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
    const sold_out = editSoldOutEl?.checked ? 1 : 0;
    const stock = stockFromInput(editStockEl?.value);
    const cost_cents = costFromInput(editCostEl?.value);

    if (!id) return alert("Prodotto non valido.");
    if (!name) return alert("Inserisci un nome prodotto.");
    if (price_cents === null) return alert("Prezzo non valido.");
    if (stock === undefined) return alert("Scorte non valide: intero >= 0 o vuoto.");
    if (cost_cents === undefined) return alert("Costo non valido: importo in euro o vuoto.");

    try {
      await api(`/api/products/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name, category, price_cents, sort_order, active, sold_out, stock, cost_cents })
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
  if (createCard) createCard.hidden = true;
}

function destroyReportCharts() {
  reportRevenueChart?.destroy();
  reportMixChart?.destroy();
  reportRevenueChart = null;
  reportMixChart = null;
}

function cssVar(name, fb) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}

// Perimetro corrente dei report: turno selezionato (prioritario) o intervallo
// di date inclusive, convertite in "to" esclusivo per le API.
function reportScopeQuery() {
  const sessionEl = document.querySelector("#sessionFilter");
  const fromEl = document.querySelector("#fromDate");
  const toEl = document.querySelector("#toDate");
  if (sessionEl?.value) {
    return { qs: `?session=${encodeURIComponent(sessionEl.value)}`, label: `turno #${sessionEl.value}` };
  }
  const from = (fromEl?.value || "").trim();
  const toInclusive = (toEl?.value || "").trim();
  if (!from || !toInclusive) return null;
  return {
    qs: `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(addDaysYmd(toInclusive, 1))}`,
    label: from === toInclusive ? from : `${from} → ${toInclusive}`,
  };
}

// Grafici del report: incassi per ora (area) e confronto giornate (barre)
function renderReportCharts(data) {
  destroyReportCharts();
  if (!window.Chart) return;

  const accent = cssVar("--accent", "#7D6FFF");
  const muted = cssVar("--muted", "#868C9B");
  const grid = cssVar("--hair", "rgba(255,255,255,.06)");
  const sym = APP_CONFIG.currencySymbol || "€";
  const moneyScales = {
    y: { beginAtZero: true, ticks: { color: muted, callback: v => `${sym} ${v}` }, grid: { color: grid } },
    x: { ticks: { color: muted }, grid: { display: false } },
  };

  const hourCanvas = document.querySelector("#reportHourChart");
  const byHour = data.byHour || [];
  if (hourCanvas && byHour.length > 0) {
    const minH = Math.min(...byHour.map(r => r.hour));
    const maxH = Math.max(...byHour.map(r => r.hour));
    const map = new Map(byHour.map(r => [r.hour, Number(r.revenue_cents) / 100]));
    const labels = [], values = [];
    for (let h = minH; h <= maxH; h++) { labels.push(String(h).padStart(2, "0")); values.push(map.get(h) || 0); }

    reportRevenueChart = new window.Chart(hourCanvas, {
      type: "line",
      data: { labels, datasets: [{
        data: values, borderColor: accent, backgroundColor: accent + "22",
        fill: true, tension: 0.35, pointRadius: 3, pointBackgroundColor: accent, borderWidth: 2,
      }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: moneyScales,
      },
    });
  }

  const dayCanvas = document.querySelector("#reportDayChart");
  const byDay = data.byDay || [];
  if (dayCanvas && byDay.length > 1) {
    reportMixChart = new window.Chart(dayCanvas, {
      type: "bar",
      data: {
        labels: byDay.map(d => d.day.slice(5)),
        datasets: [{ data: byDay.map(d => Number(d.revenue_cents) / 100), backgroundColor: accent + "CC", borderRadius: 6 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: moneyScales,
      },
    });
  }
}

async function initReport() {
  const box = document.querySelector("#reportBox");
  if (!box) return;

  const fromEl = document.querySelector("#fromDate");
  const toEl = document.querySelector("#toDate");
  const sessionEl = document.querySelector("#sessionFilter");
  const PAY_LABEL = { cash: "Contanti", card: "Carta", other: "Altro" };
  const fmtDateTime = v => v ? new Date(v + "Z").toLocaleString(APP_CONFIG.locale, { dateStyle: "short", timeStyle: "short" }) : "—";

  // default: oggi (solo se vuoti: il cambio tema ri-esegue initReport)
  const today = ymd(new Date());
  if (fromEl && !fromEl.value) fromEl.value = today;
  if (toEl && !toEl.value) toEl.value = today;

  // Selettore turni + tabella chiusure
  let sessions = [];
  try {
    sessions = (await api("/api/sessions?limit=100")).sessions || [];
  } catch {
    // senza elenco turni restano il filtro per data e la dashboard
  }

  if (sessionEl) {
    const selected = sessionEl.value;
    sessionEl.innerHTML = '<option value="">Tutto il periodo</option>' + sessions.map(s => {
      const label = `#${s.id} · ${fmtDateTime(s.opened_at)}${s.operator ? " · " + s.operator : ""}${s.closed_at ? "" : " (aperto)"}`;
      return `<option value="${s.id}">${escapeHtml(label)}</option>`;
    }).join("");
    if (selected && sessions.some(s => String(s.id) === selected)) sessionEl.value = selected;
  }

  function renderClosures() {
    const tbody = document.querySelector("#closuresTable");
    if (!tbody) return;
    if (sessions.length === 0) {
      tbody.innerHTML = "<tr><td colspan='9' class='empty-state'>Nessun turno registrato.</td></tr>";
      return;
    }
    tbody.innerHTML = sessions.map(s => {
      const t = s.totals || {};
      const closed = Boolean(s.closed_at);
      const expected = closed ? s.expected_cash_cents : t.expectedCashCents;
      let diffCell = "<span class='small'>in corso</span>";
      if (closed) {
        const diff = s.difference_cents || 0;
        const cls = diff === 0 ? "diff-ok" : (diff > 0 ? "diff-plus" : "diff-minus");
        diffCell = `<span class="${cls}">${diff >= 0 ? "+" : "−"} ${money(Math.abs(diff))}</span>`;
      }
      const movements = (t.movementsInCents || 0) > 0 || (t.movementsOutCents || 0) > 0
        ? `<div class="small">Mov.: +${money(t.movementsInCents || 0)} / −${money(t.movementsOutCents || 0)}</div>`
        : "";
      return `
        <tr>
          <td data-label="Turno"><b>#${s.id}</b></td>
          <td data-label="Operatore">${escapeHtml(s.operator || "—")}</td>
          <td data-label="Apertura">${fmtDateTime(s.opened_at)}</td>
          <td data-label="Chiusura">${closed ? fmtDateTime(s.closed_at) : '<span class="status-pill is-active">Aperto</span>'}</td>
          <td data-label="Incasso">${money(t.revenueCents || 0)}</td>
          <td data-label="Attesi">${money(expected || 0)}</td>
          <td data-label="Contati">${closed ? money(s.counted_cash_cents || 0) : "—"}</td>
          <td data-label="Differenza">${diffCell}</td>
          <td data-label="Note">${escapeHtml(s.note || "")}${movements}</td>
        </tr>`;
    }).join("");
  }

  async function render() {
    const scope = reportScopeQuery();
    if (!scope) return;
    const data = await api(`/api/reports/summary${scope.qs}`);
    const s = data.summary;
    const count = s.sales_count || 0;
    const avg = count > 0 ? Math.round(s.revenue_cents / count) : 0;
    const byDay = data.byDay || [];
    const multiDay = byDay.length > 1;

    const payTotal = (data.byPayment || []).reduce((a, b) => a + b.revenue_cents, 0) || 1;
    const payBars = (data.byPayment || []).map(p => {
      const pct = Math.round(p.revenue_cents / payTotal * 100);
      return `
        <div class="bar-row">
          <div class="bar-head">
            <b>${escapeHtml(PAY_LABEL[p.payment_method] || p.payment_method)}</b>
            <span><span class="amt">${euro(p.revenue_cents)}</span> <span class="pct">${pct}%</span></span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <div class="small">${p.count} vendite</div>
        </div>`;
    }).join("") || "<div class='empty-state'>Nessun incasso nel periodo.</div>";

    const prodMax = Math.max(1, ...data.byProduct.map(p => p.qty_sold));
    const prodRows = data.byProduct.map(p => {
      const sub = [`${p.qty_sold} venduti`];
      if (p.gross_revenue_cents !== p.net_revenue_cents) sub.push(`lordo ${euro(p.gross_revenue_cents)}`);
      if (p.margin_cents !== null) {
        sub.push(`${p.margin_complete ? "margine" : "margine parziale"} ${euro(p.margin_cents)}`);
      }
      return `
        <div class="bar-row">
          <div class="bar-head"><b>${escapeHtml(p.name)}</b><span class="amt">${euro(p.net_revenue_cents)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round(p.qty_sold / prodMax * 100)}%"></div></div>
          <div class="small">${sub.join(" · ")}</div>
        </div>`;
    }).join("") || "<div class='empty-state'>Nessuna vendita nel periodo.</div>";

    const dayMax = Math.max(1, ...byDay.map(d => d.revenue_cents));
    const dayRows = byDay.map(d => {
      const label = new Date(d.day + "T00:00:00").toLocaleDateString(APP_CONFIG.locale, { weekday: "short", day: "numeric", month: "short" });
      return `
        <div class="bar-row">
          <div class="bar-head"><b>${escapeHtml(label)}</b><span class="amt">${euro(d.revenue_cents)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round(d.revenue_cents / dayMax * 100)}%"></div></div>
          <div class="small">${d.sales_count} vendite</div>
        </div>`;
    }).join("");

    const marginLabel = s.margin_complete ? "Margine" : "Margine parziale";
    const marginSub = s.margin_complete
      ? `costi completi su ${s.margin_products} prodotti`
      : `${s.margin_coverage_percent || 0}% dell'incasso coperto dai costi`;
    const marginTile = s.margin_cents === null ? "" : `
      <div class="kpi">
        <div class="k-label">${marginLabel}</div>
        <div class="k-value">${euro(s.margin_cents)}</div>
        <div class="k-sub">${marginSub}</div>
      </div>`;

    const dayCompare = !multiDay ? "" : `
      <div class="report-grid">
        <section class="card chart-card">
          <div class="section-heading section-heading-tight">
            <div><div class="eyebrow">Confronto</div><h2>Incassi per giornata</h2></div>
          </div>
          <div class="chart-wrap"><canvas id="reportDayChart" aria-label="Grafico incassi per giornata"></canvas></div>
        </section>
        <section class="card">
          <div class="section-heading section-heading-tight">
            <div><div class="eyebrow">Giornate</div><h2>Dettaglio per giorno</h2></div>
          </div>
          <div class="bars">${dayRows}</div>
        </section>
      </div>`;

    box.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi kpi-accent">
          <div class="k-label">Incasso</div>
          <div class="k-value">${euro(s.revenue_cents)}</div>
          <div class="k-sub">${escapeHtml(scope.label)}</div>
        </div>
        <div class="kpi">
          <div class="k-label">Vendite</div>
          <div class="k-value">${count}</div>
          <div class="k-sub">ticket emessi</div>
        </div>
        <div class="kpi">
          <div class="k-label">Scontrino medio</div>
          <div class="k-value">${euro(avg)}</div>
          <div class="k-sub">per comanda</div>
        </div>
        <div class="kpi">
          <div class="k-label">Sconti e omaggi</div>
          <div class="k-value">${euro(s.discount_cents || 0)}</div>
          <div class="k-sub">erogati nel periodo</div>
        </div>
        ${marginTile}
      </div>

      ${dayCompare}

      <div class="report-grid">
        <section class="card chart-card">
          <div class="section-heading section-heading-tight">
            <div><div class="eyebrow">Andamento</div><h2>Incassi per ora</h2></div>
          </div>
          <div class="chart-wrap"><canvas id="reportHourChart" aria-label="Grafico incassi per ora"></canvas></div>
        </section>
        <section class="card">
          <div class="section-heading section-heading-tight">
            <div><div class="eyebrow">Ripartizione</div><h2>Metodi di pagamento</h2></div>
          </div>
          <div class="bars">${payBars}</div>
        </section>
      </div>

      <section class="card">
        <div class="section-heading section-heading-tight">
          <div><div class="eyebrow">Dettaglio</div><h2>Prodotti più venduti</h2></div>
        </div>
        <div class="bars">${prodRows}</div>
      </section>
    `;

    renderReportCharts(data);
  }

  // onchange (assegnazione, non addEventListener): niente doppi binding
  // quando initReport viene rieseguito dal router o dal cambio tema.
  if (fromEl) fromEl.onchange = () => render().catch(err => alert(err.message));
  if (toEl) toEl.onchange = () => render().catch(err => alert(err.message));
  if (sessionEl) sessionEl.onchange = () => render().catch(err => alert(err.message));

  renderClosures();
  await render();
}

async function initReportExport() {
  const btn = document.querySelector("#downloadCsvBtn");
  const txBtn = document.querySelector("#downloadTxCsvBtn");
  const itemsBtn = document.querySelector("#downloadItemsCsvBtn");
  const restoreFile = document.querySelector("#restoreFile");
  const selectRestoreFileBtn = document.querySelector("#selectRestoreFileBtn");
  const restoreBackupBtn = document.querySelector("#restoreBackupBtn");
  const restoreFileName = document.querySelector("#restoreFileName");
  const toastEl = document.querySelector("#toast");

  const viewButtons = Array.from(document.querySelectorAll("[data-report-view]"));
  const viewPanels = Array.from(document.querySelectorAll("[data-report-panel]"));
  function setReportView(view) {
    viewButtons.forEach(button => {
      const active = button.getAttribute("data-report-view") === view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    viewPanels.forEach(panel => {
      const active = panel.getAttribute("data-report-panel") === view;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
    });
  }
  viewButtons.forEach(button => {
    button.onclick = () => setReportView(button.getAttribute("data-report-view"));
  });
  if (viewButtons.length > 0) setReportView("summary");

  if (!btn) return;

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 1700);
  }

  // Gli export usano lo stesso perimetro della dashboard (date o turno)
  function download(endpoint, name) {
    const scope = reportScopeQuery();
    if (!scope) { alert("Seleziona entrambe le date (Da / A) o un turno."); return; }
    showToast(`${name}: ${scope.label}`);
    window.location.href = `${endpoint}${scope.qs}`;
  }

  btn.onclick = () => download("/api/reports/export.csv", "CSV prodotti");
  if (txBtn) txBtn.onclick = () => download("/api/reports/transactions.csv", "CSV transazioni");
  if (itemsBtn) itemsBtn.onclick = () => download("/api/reports/items.csv", "CSV righe vendute");

  if (selectRestoreFileBtn && restoreFile) {
    selectRestoreFileBtn.onclick = () => restoreFile.click();
    restoreFile.onchange = () => {
      const file = restoreFile.files?.[0];
      if (restoreFileName) restoreFileName.textContent = file?.name || "Nessun file selezionato";
      if (restoreBackupBtn) restoreBackupBtn.disabled = !file;
    };
  }

  if (restoreBackupBtn && restoreFile) {
    restoreBackupBtn.onclick = async () => {
      const file = restoreFile.files?.[0];
      if (!file) return;
      if (file.size > 100 * 1024 * 1024) {
        alert("Il file supera il limite di 100 MB.");
        return;
      }

      const confirmation = await uiPrompt(
        "Ripristina backup",
        `Scrivi RIPRISTINA per sostituire i dati correnti con ${file.name}`
      );
      if (confirmation !== "RIPRISTINA") {
        if (confirmation !== null) alert("Conferma non corretta: ripristino annullato.");
        return;
      }

      const previousLabel = restoreBackupBtn.textContent;
      restoreBackupBtn.disabled = true;
      restoreBackupBtn.textContent = "Verifica in corso…";
      try {
        const res = await fetch("/api/reports/restore", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-EventOrder-Restore": "RESTORE",
          },
          body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Ripristino non riuscito");

        alert(`Ripristino completato. Backup di sicurezza creato: ${data.safety_backup}`);
        location.reload();
      } catch (err) {
        alert(err.message);
        restoreBackupBtn.disabled = false;
        restoreBackupBtn.textContent = previousLabel;
      }
    };
  }
}

// --------------------
// VENDITE (storico + storni)
async function initSales() {
  const listEl = document.querySelector("#salesList");
  const refreshBtn = document.querySelector("#refreshSalesBtn");
  const filtersForm = document.querySelector("#salesFilters");
  const resetBtn = document.querySelector("#resetSalesFilters");
  const listTitle = document.querySelector("#salesListTitle");
  const toastEl = document.querySelector("#toast");
  const toggleFiltersBtn = document.querySelector("#toggleSalesFilters");
  const advancedFilters = document.querySelector("#advancedSalesFilters");
  const filterSummary = document.querySelector("#salesFilterSummary");
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
    const printWarning = !sale.voided && sale.print_status !== "printed"
      ? `<span class="status-pill ${sale.print_status === "failed" ? "is-soldout" : "is-inactive"}">${sale.print_status === "failed" ? "Stampa fallita" : "Stampa da verificare"}</span>`
      : "";
    return `
      <div class="surface-card sale-row ${sale.voided ? "is-voided" : ""}">
        <div class="sale-main">
          <div class="sale-head">
            <b>#${num}</b>
            <span class="status-pill ${sale.voided ? "is-inactive" : "is-active"}">${sale.voided ? "Annullata" : PAY_LABEL[sale.payment_method] || sale.payment_method}</span>
            ${printWarning}
            ${sale.operator ? `<span class="small">${escapeHtml(sale.operator)}</span>` : ""}
          </div>
          <div class="small">${when}</div>
          <div class="small sale-items">${items || "—"}</div>
          ${sale.voided && sale.void_reason ? `<div class="small sale-void-reason">Motivo: ${escapeHtml(sale.void_reason)}</div>` : ""}
        </div>
        <div class="sale-side">
          <div class="line-total">${euro(sale.total_cents)}</div>
          ${sale.can_reprint ? `<button class="btn btn-secondary btn-compact" data-reprint="${sale.id}" data-sale-number="${num}" type="button">Ristampa</button>` : ""}
          ${sale.can_void ? `<button class="btn btn-secondary btn-compact" data-void="${sale.id}" type="button">Annulla</button>` : ""}
        </div>
      </div>
    `;
  }

  // Querystring dai filtri compilati (i campi vuoti non vengono inviati)
  function filtersQuery() {
    const params = new URLSearchParams({ limit: "100" });
    if (!filtersForm) return params;
    for (const name of ["number", "from", "to", "product", "operator", "method", "status"]) {
      const value = String(filtersForm[name]?.value || "").trim();
      if (value) params.set(name, value);
    }
    return params;
  }

  function setAdvancedFilters(open) {
    if (!advancedFilters || !toggleFiltersBtn) return;
    advancedFilters.hidden = !open;
    toggleFiltersBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function syncFilterSummary() {
    if (!filtersForm) return;
    const advancedNames = ["from", "to", "operator", "method", "status"];
    const active = advancedNames.filter(name => String(filtersForm[name]?.value || "").trim()).length;
    if (filterSummary) {
      filterSummary.textContent = active === 0
        ? "Nessun filtro avanzato"
        : `${active} ${active === 1 ? "filtro avanzato attivo" : "filtri avanzati attivi"}`;
    }
    if (toggleFiltersBtn) toggleFiltersBtn.textContent = active > 0 ? `Altri filtri (${active})` : "Altri filtri";
    if (active > 0) setAdvancedFilters(true);
  }

  async function refresh() {
    const params = filtersQuery();
    const sales = await api(`/api/sales?${params.toString()}`);
    const filtered = [...params.keys()].length > 1;
    if (listTitle) listTitle.textContent = filtered ? `Risultati (${sales.length})` : "Vendite recenti";
    listEl.innerHTML = sales.length
      ? sales.map(saleCard).join("")
      : "<div class='empty-state'>Nessuna vendita trovata con questi filtri.</div>";
  }

  listEl.addEventListener("click", async (e) => {
    const reprintId = e.target?.getAttribute?.("data-reprint");
    if (reprintId) {
      const saleNumber = e.target.getAttribute("data-sale-number") || "";
      const confirmed = await uiConfirm(
        `Ristampare il ticket #${saleNumber}?`,
        "Ristampa ticket"
      );
      if (!confirmed) return;
      e.target.disabled = true;
      try {
        const result = await api(`/api/sales/${encodeURIComponent(reprintId)}/reprint`, {
          method: "POST",
        });
        showToast(`Ticket #${String(result.sale_number).padStart(4, "0")} ristampato`);
      } catch (err) {
        alert(err.message);
      } finally {
        await refresh().catch(err => alert(err.message));
      }
      return;
    }

    const id = e.target?.getAttribute?.("data-void");
    if (!id) return;
    const reason = await uiPrompt("Annulla vendita", "Motivo dell'annullo (opzionale)", "");
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

  refreshBtn?.addEventListener("click", () => refresh().catch(err => alert(err.message)));
  toggleFiltersBtn?.addEventListener("click", () => {
    setAdvancedFilters(toggleFiltersBtn.getAttribute("aria-expanded") !== "true");
  });
  if (filtersForm) filtersForm.onsubmit = (e) => {
    e.preventDefault();
    syncFilterSummary();
    refresh().catch(err => alert(err.message));
  };
  if (filtersForm) filtersForm.onchange = syncFilterSummary;
  if (resetBtn) resetBtn.onclick = () => {
    filtersForm?.reset();
    setAdvancedFilters(false);
    syncFilterSummary();
    refresh().catch(err => alert(err.message));
  };
  syncFilterSummary();
  await refresh();
}

// --------------------
document.addEventListener("DOMContentLoaded", async () => {
  try {
    // Sidebar subito (senza attendere la rete): layout stabile dal primo paint.
    renderSidebar(document.body.dataset.page || "");
    initRouter();
    await loadConfig();
    applyBranding();
    refreshBrand();
    syncAuthControls();
    await runPageInits();
    await refreshShellData();
  } catch (e) {
    console.error(e);
    alert(e.message || String(e));
  }
});
