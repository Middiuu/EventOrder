// Config caricata da /api/config all'avvio (branding, valuta, locale)
let APP_CONFIG = {
  appName: "EventOrder",
  businessName: "EventOrder",
  tagline: "Cassa locale",
  currencySymbol: "€",
  currencyCode: "EUR",
  locale: "it-IT",
};

function money(cents) {
  const locale = APP_CONFIG.locale || "it-IT";
  const currency = APP_CONFIG.currencyCode || "EUR";
  const symbol = APP_CONFIG.currencySymbol;
  const parts = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  }).formatToParts(Number(cents) / 100);
  return parts.map(part => part.type === "currency" && symbol ? symbol : part.value).join("");
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
  const setCount = (key, value) => {
    const el = document.querySelector(`[data-count="${key}"]`);
    if (el) el.textContent = value;
  };
  const [sessionResult, summaryResult] = await Promise.allSettled([
    api("/api/sessions/current"),
    api("/api/shell/summary"),
  ]);

  updateSessionCard(sessionResult.status === "fulfilled"
    ? sessionResult.value.session || null
    : null);
  if (summaryResult.status === "fulfilled") {
    setCount("prodotti", summaryResult.value.active_products);
    setCount("vendite", summaryResult.value.valid_sales);
  }
}

// ---- Navigazione client-side: niente reload/flash tra le sezioni
const APP_PAGES = new Set(["/cassa.html", "/products.html", "/sales.html", "/reports.html"]);

const scriptLoads = new Map();

function ensureScript(src) {
  if (scriptLoads.has(src)) return scriptLoads.get(src);
  const load = new Promise((resolve, reject) => {
    const existing = [...document.scripts].find(script => script.src.endsWith(src));
    if (existing?.dataset.loaded === "true") return resolve();
    if (existing) existing.remove();
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => {
      el.dataset.loaded = "true";
      resolve();
    };
    el.onerror = () => reject(new Error(`Risorsa frontend non disponibile: ${src}`));
    document.body.appendChild(el);
  });
  scriptLoads.set(src, load);
  load.catch(() => scriptLoads.delete(src));
  return load;
}

let pageInitController = null;
let navigationController = null;
let navigationSequence = 0;

async function runPageInits() {
  pageInitController?.abort();
  pageInitController = new AbortController();
  const { signal } = pageInitController;
  const initializers = [
    ["cassa", () => initCassa(signal)],
    ["prodotti", () => initProdotti(signal)],
    ["vendite", () => initSales()],
    ["report", () => initReport()],
    ["export report", () => initReportExport()],
  ];
  for (const [name, initialize] of initializers) {
    try {
      await initialize();
    } catch (error) {
      console.error(`Inizializzazione ${name} non riuscita:`, error);
    }
  }
}

function setActiveNav(url) {
  document.querySelectorAll(".side-nav a").forEach(a => {
    a.classList.toggle("is-active", a.getAttribute("href") === url);
  });
}

async function clientNavigate(url, push = true) {
  navigationController?.abort();
  navigationController = new AbortController();
  const { signal } = navigationController;
  const sequence = ++navigationSequence;
  let html;
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Navigazione non riuscita (${response.status})`);
    html = await response.text();
  } catch (error) {
    if (error.name === "AbortError") return;
    location.href = url;
    return;
  }
  if (signal.aborted || sequence !== navigationSequence) return;

  const doc = new DOMParser().parseFromString(html, "text/html");
  const newMain = doc.querySelector(".main");
  const curMain = document.querySelector(".main");
  if (!newMain || !curMain) { location.href = url; return; }

  disposePageUi();
  curMain.replaceWith(newMain);
  document.title = doc.title || document.title;
  document.body.dataset.page = doc.body.dataset.page || "";
  setActiveNav(url);
  if (push) history.pushState({ eo: true }, "", url);
  window.scrollTo(0, 0);

  const page = document.body.dataset.page;
  try {
    if (page === "prodotti") await ensureScript("/vendor/sortablejs/Sortable.min.js");
    if (page === "report") await ensureScript("/vendor/chart.js/dist/chart.umd.min.js");
  } catch (error) {
    console.error(error);
    await uiAlert("Una risorsa della pagina non è disponibile. Alcune funzioni potrebbero essere disabilitate.", "Caricamento incompleto");
  }
  if (signal.aborted || sequence !== navigationSequence) return;
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

async function withFormSubmitLock(form, action) {
  if (!form || form.dataset.submitting === "true") return undefined;
  form.dataset.submitting = "true";
  form.setAttribute("aria-busy", "true");
  const submitControls = [...form.querySelectorAll('button[type="submit"], input[type="submit"]')];
  const disabledBefore = submitControls.map(control => control.disabled);
  submitControls.forEach(control => { control.disabled = true; });
  try {
    return await action();
  } finally {
    delete form.dataset.submitting;
    form.removeAttribute("aria-busy");
    submitControls.forEach((control, index) => { control.disabled = disabledBefore[index]; });
  }
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

const modalStack = [];
const modalFocusOrigins = new WeakMap();
const managedInert = new Map();

const MODAL_FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function visibleFocusableElements(el) {
  return Array.from(el?.querySelectorAll?.(MODAL_FOCUSABLE) || [])
    .filter(node => !node.hidden && !node.closest("[hidden]") && node.getClientRects().length > 0);
}

function topOpenModal() {
  for (let i = modalStack.length - 1; i >= 0; i -= 1) {
    if (modalStack[i]?.isConnected && !modalStack[i].hidden) return modalStack[i];
  }
  return null;
}

function isTopModal(el) {
  return topOpenModal() === el;
}

function restoreManagedInert() {
  for (const [el, wasInert] of managedInert) {
    if (el.isConnected) el.inert = wasInert;
  }
  managedInert.clear();
}

function makeManagedInert(el) {
  if (!managedInert.has(el)) managedInert.set(el, el.inert);
  el.inert = true;
}

function isolateModal(el) {
  // Rende inerte ogni ramo fratello lungo il percorso modale -> body. In
  // questo modo funzionano sia le modali dentro #app sia i dialoghi dinamici
  // aggiunti direttamente al body.
  let current = el;
  while (current?.parentElement) {
    for (const sibling of current.parentElement.children) {
      if (sibling !== current) makeManagedInert(sibling);
    }
    current = current.parentElement;
  }
}

function syncModalState() {
  restoreManagedInert();
  const top = topOpenModal();
  document.body.style.overflow = top ? "hidden" : "";
  if (top) isolateModal(top);
}

function disposePageUi() {
  pageInitController?.abort();
  for (const modal of modalStack) {
    if (modal?.isConnected) modal.hidden = true;
    modalFocusOrigins.delete(modal);
  }
  modalStack.length = 0;
  restoreManagedInert();
  document.body.style.overflow = "";
}

function focusModal(el) {
  if (!isTopModal(el)) return;
  const dialog = el.querySelector("[role='dialog']") || el;
  const target = el.querySelector("[autofocus]")
    || visibleFocusableElements(el)[0]
    || dialog;
  if (target === dialog && !dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
  target.focus({ preventScroll: true });
}

function openModal(el) {
  if (!el) return;
  const existingIndex = modalStack.indexOf(el);
  if (existingIndex === -1) {
    modalFocusOrigins.set(el, document.activeElement);
  } else {
    modalStack.splice(existingIndex, 1);
  }
  el.hidden = false;
  modalStack.push(el);
  syncModalState();
  setTimeout(() => {
    if (isTopModal(el) && !el.contains(document.activeElement)) focusModal(el);
  }, 0);
}

function closeModal(el) {
  if (!el) return;
  const wasTop = isTopModal(el);
  const index = modalStack.lastIndexOf(el);
  if (index !== -1) modalStack.splice(index, 1);
  el.hidden = true;
  syncModalState();

  if (wasTop) {
    const origin = modalFocusOrigins.get(el);
    modalFocusOrigins.delete(el);
    if (origin?.isConnected && !origin.closest("[inert]")) {
      setTimeout(() => origin.focus({ preventScroll: true }), 0);
    } else {
      const next = topOpenModal();
      if (next) setTimeout(() => focusModal(next), 0);
    }
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const modal = topOpenModal();
  if (!modal) return;
  const focusable = visibleFocusableElements(modal);
  if (focusable.length === 0) {
    e.preventDefault();
    focusModal(modal);
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !modal.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !modal.contains(active))) {
    e.preventDefault();
    first.focus();
  }
});

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
    <div class="modal-card dialog-card" role="dialog" aria-modal="true" aria-labelledby="appDialogTitle" aria-describedby="appDialogMessage">
      <h2 id="appDialogTitle" class="dialog-title"></h2>
      <p id="appDialogMessage" class="dialog-message"></p>
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

function openDialog({ title, message, input, okLabel, cancelable = true, tone } = {}) {
  return new Promise((resolve) => {
    const el = ensureDialog();
    const card = el.querySelector(".dialog-card");
    card.classList.remove("is-alert", "is-warning", "is-danger", "is-success");
    if (tone) card.classList.add("is-alert", `is-${tone}`);
    card.setAttribute("role", tone ? "alertdialog" : "dialog");
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
    const cancel = el.querySelector('[data-dlg="cancel"]:not(.modal-backdrop)');
    ok.textContent = okLabel || "Conferma";
    cancel.hidden = !cancelable;
    openModal(el);

    function cleanup(result) {
      closeModal(el);
      ok.removeEventListener("click", onOk);
      el.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    const onOk = () => cleanup(input ? inputEl.value : true);
    const onCancel = (e) => {
      if (cancelable && e.target?.getAttribute?.("data-dlg") === "cancel") cleanup(input ? null : false);
    };
    const onKey = (e) => {
      if (!isTopModal(el)) return;
      if (e.key === "Escape") cleanup(cancelable ? (input ? null : false) : true);
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
const uiAlert = (message, title = "Attenzione", tone = "warning") => (
  openDialog({ title, message, okLabel: "Chiudi", cancelable: false, tone })
);
const uiError = (error) => uiAlert(error?.message || String(error), "Operazione non riuscita", "danger");

// --------------------
// CASSA
async function initCassa(signal) {
  const grid = document.querySelector("#productsGrid");
  const cartEl = document.querySelector("#cart");
  const totalEl = document.querySelector("#total");
  const printBtn = document.querySelector("#printBtn");
  const clearBtn = document.querySelector("#clearBtn");
  const searchEl = document.querySelector("#search");
  const categoryFiltersEl = document.querySelector("#categoryFilters");
  const toastEl = document.querySelector("#toast");
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
  const createOptionsRoot = document.querySelector("#createOptionsEditor");
  const editOptionsRoot = document.querySelector("#editOptionsEditor");

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

  function setupOptionsEditor(root) {
    const list = root?.querySelector("[data-option-groups]");
    if (!root || !list) return { reset() {}, set() {}, read() { return { groups: [] }; } };

    function optionRow(option = {}) {
      const row = document.createElement("div");
      row.className = "option-value-row";
      if (option.id) row.dataset.optionId = String(option.id);
      row.innerHTML = `
        <label class="field"><span class="field-label">Scelta</span><input class="input" data-option-name maxlength="80" placeholder="Es. Grande" value="${escapeHtml(option.name || "")}"></label>
        <label class="field"><span class="field-label">Variazione €</span><input class="input mono" data-option-price type="number" step="0.01" value="${(Number(option.price_delta_cents || 0) / 100).toFixed(2)}"></label>
        <button class="btn btn-ghost btn-compact" type="button" data-remove-option>Rimuovi</button>`;
      return row;
    }

    function addGroup(group = {}) {
      const card = document.createElement("div");
      card.className = "option-group-card";
      if (group.id) card.dataset.groupId = String(group.id);
      card.innerHTML = `
        <div class="option-group-row">
          <label class="field"><span class="field-label">Nome gruppo</span><input class="input" data-group-name maxlength="80" placeholder="Es. Formato" value="${escapeHtml(group.name || "")}"></label>
          <label class="field"><span class="field-label">Tipo</span><select class="input" data-group-type><option value="single">Scelta singola</option><option value="multiple">Scelta multipla</option></select></label>
          <label class="toggle"><input type="checkbox" data-group-required><span>Obbligatoria</span></label>
          <button class="btn btn-ghost btn-compact" type="button" data-remove-group>Rimuovi gruppo</button>
        </div>
        <div class="option-values-list" data-option-values></div>
        <button class="btn btn-secondary btn-compact" type="button" data-add-option>Aggiungi scelta</button>`;
      card.querySelector("[data-group-type]").value = group.selection_type || "single";
      card.querySelector("[data-group-required]").checked = Boolean(group.required);
      const values = card.querySelector("[data-option-values]");
      const options = group.options?.length ? group.options : [{}, {}];
      for (const option of options) values.appendChild(optionRow(option));
      list.appendChild(card);
    }

    root.addEventListener("click", event => {
      if (event.target.closest("[data-add-option-group]")) addGroup();
      const removeGroup = event.target.closest("[data-remove-group]");
      if (removeGroup) removeGroup.closest(".option-group-card")?.remove();
      const addOption = event.target.closest("[data-add-option]");
      if (addOption) addOption.closest(".option-group-card")?.querySelector("[data-option-values]")?.appendChild(optionRow());
      const removeOption = event.target.closest("[data-remove-option]");
      if (removeOption) removeOption.closest(".option-value-row")?.remove();
    });

    return {
      reset() { list.innerHTML = ""; },
      set(groups = []) { list.innerHTML = ""; groups.forEach(addGroup); },
      read() {
        const groups = [];
        for (const [groupIndex, card] of [...list.querySelectorAll(".option-group-card")].entries()) {
          const name = card.querySelector("[data-group-name]").value.trim();
          if (!name) return { error: `Inserisci il nome del gruppo ${groupIndex + 1}.` };
          const options = [];
          for (const [optionIndex, row] of [...card.querySelectorAll(".option-value-row")].entries()) {
            const optionName = row.querySelector("[data-option-name]").value.trim();
            const rawPrice = row.querySelector("[data-option-price]").value.trim() || "0";
            const price = Number(rawPrice.replace(",", "."));
            if (!optionName) return { error: `Inserisci il nome della scelta ${optionIndex + 1} in ${name}.` };
            if (!Number.isFinite(price)) return { error: `Variazione prezzo non valida in ${name}.` };
            options.push({
              ...(row.dataset.optionId ? { id: Number(row.dataset.optionId) } : {}),
              name: optionName,
              price_delta_cents: Math.round(price * 100),
            });
          }
          if (options.length === 0) return { error: `Aggiungi almeno una scelta al gruppo ${name}.` };
          groups.push({
            ...(card.dataset.groupId ? { id: Number(card.dataset.groupId) } : {}),
            name,
            selection_type: card.querySelector("[data-group-type]").value,
            required: card.querySelector("[data-group-required]").checked ? 1 : 0,
            options,
          });
        }
        return { groups };
      },
    };
  }

  const createOptionsEditor = setupOptionsEditor(createOptionsRoot);
  const editOptionsEditor = setupOptionsEditor(editOptionsRoot);

  function resetCreateForm() {
    form.reset();
    sortEl.value = "0";
    activeEl.checked = true;
    createOptionsEditor.reset();
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
    editOptionsEditor.set(product.option_groups || []);
    openModal(modalEl);
    setTimeout(() => editNameEl.focus(), 0);
  }

  function closeEditModal() {
    if (!modalEl || !editForm) return;
    closeModal(modalEl);
    editForm.reset();
    editOptionsEditor.reset();
  }

  function statusPill(p) {
    if (!p.active) return '<span class="status-pill is-inactive">Disattivo</span>';
    if (p.sold_out || (p.stock != null && p.stock <= 0)) {
      return '<span class="status-pill is-soldout">Esaurito</span>';
    }
    return '<span class="status-pill is-active">Attivo</span>';
  }

  function renderTable() {
    const canReorder = !(searchEl?.value || "").trim();
    table.innerHTML = filteredRows.map((p, index) => `
      <tr>
        <td data-label="Sposta">
          <span class="table-handle" aria-hidden="true">⋮⋮</span>
          <span class="reorder-actions">
            <button class="btn btn-ghost btn-compact" data-move-product="${p.id}" data-direction="up" type="button" aria-label="Sposta ${escapeHtml(p.name)} in alto" ${!canReorder || index === 0 ? "disabled" : ""}>↑</button>
            <button class="btn btn-ghost btn-compact" data-move-product="${p.id}" data-direction="down" type="button" aria-label="Sposta ${escapeHtml(p.name)} in basso" ${!canReorder || index === filteredRows.length - 1 ? "disabled" : ""}>↓</button>
          </span>
        </td>
        <td data-label="Stato">${statusPill(p)}</td>
        <td data-label="Nome"><b>${escapeHtml(p.name)}</b>${p.option_groups?.length ? `<div class="small">${p.option_groups.length} ${p.option_groups.length === 1 ? "gruppo opzioni" : "gruppi opzioni"}</div>` : ""}</td>
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

          try {
            await moveProduct(evt.oldIndex, evt.newIndex);
          } catch (err) {
            await uiError(err);
            await refresh();
          }
        }
      });
    }

    sortable.option("disabled", Boolean((searchEl?.value || "").trim()));
  }

  async function moveProduct(fromIndex, toIndex) {
    if ((searchEl?.value || "").trim()) {
      showToast("Svuota la ricerca per riordinare l'elenco.");
      return;
    }
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    const moved = filteredRows.splice(fromIndex, 1)[0];
    filteredRows.splice(toIndex, 0, moved);
    allRows = [...filteredRows];
    await api("/api/products/reorder", {
      method: "POST",
      body: JSON.stringify({ order: allRows.map(row => row.id) })
    });
    showToast("Ordine prodotti aggiornato");
    await refresh();
  }

  async function refresh() {
    allRows = await api("/api/products/all");
    filteredRows = [...allRows];
    applySearch();
  }

  table.addEventListener("click", (e) => {
    const moveButton = e.target?.closest?.("[data-move-product]");
    if (moveButton) {
      const index = allRows.findIndex(row => String(row.id) === moveButton.dataset.moveProduct);
      const offset = moveButton.dataset.direction === "up" ? -1 : 1;
      moveButton.disabled = true;
      moveProduct(index, index + offset).catch(async err => {
        await uiError(err);
        await refresh();
      });
      return;
    }
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
      await uiError(err);
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
    if (e.key === "Escape" && modalEl && isTopModal(modalEl)) {
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
    const optionGroups = createOptionsEditor.read();

    if (!name) return uiAlert("Inserisci un nome prodotto.");
    if (price_cents === null) return uiAlert("Prezzo non valido.");
    if (stock === undefined) return uiAlert("Scorte non valide: intero >= 0 o vuoto.");
    if (cost_cents === undefined) return uiAlert("Costo non valido: importo in euro o vuoto.");
    if (optionGroups.error) return uiAlert(optionGroups.error);

    await withFormSubmitLock(form, async () => {
      try {
        await api("/api/products", { method: "POST", body: JSON.stringify({
          name, category, price_cents, sort_order, active, stock, cost_cents,
          option_groups: optionGroups.groups,
        }) });
        showToast("Prodotto creato");
        await refresh();
        closeCreateForm();
      } catch (err) {
        await uiError(err);
      }
    });
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
    const optionGroups = editOptionsEditor.read();

    if (!id) return uiAlert("Prodotto non valido.");
    if (!name) return uiAlert("Inserisci un nome prodotto.");
    if (price_cents === null) return uiAlert("Prezzo non valido.");
    if (stock === undefined) return uiAlert("Scorte non valide: intero >= 0 o vuoto.");
    if (cost_cents === undefined) return uiAlert("Costo non valido: importo in euro o vuoto.");
    if (optionGroups.error) return uiAlert(optionGroups.error);

    await withFormSubmitLock(editForm, async () => {
      try {
        await api(`/api/products/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            name, category, price_cents, sort_order, active, sold_out, stock, cost_cents,
            option_groups: optionGroups.groups,
          })
        });
        showToast("Prodotto aggiornato");
        closeEditModal();
        await refresh();
        resetCreateForm();
      } catch (err) {
        await uiError(err);
      }
    });
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
  if (fromEl) fromEl.onchange = () => render().catch(uiError);
  if (toEl) toEl.onchange = () => render().catch(uiError);
  if (sessionEl) sessionEl.onchange = () => render().catch(uiError);

  renderClosures();
  await render();
}

async function initReportExport() {
  const btn = document.querySelector("#downloadCsvBtn");
  const txBtn = document.querySelector("#downloadTxCsvBtn");
  const itemsBtn = document.querySelector("#downloadItemsCsvBtn");
  const createBackupBtn = document.querySelector("#createBackupBtn");
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
      button.tabIndex = active ? 0 : -1;
    });
    viewPanels.forEach(panel => {
      const active = panel.getAttribute("data-report-panel") === view;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
    });
  }
  viewButtons.forEach(button => {
    button.onclick = () => setReportView(button.getAttribute("data-report-view"));
    button.onkeydown = event => {
      const current = viewButtons.indexOf(button);
      let next = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % viewButtons.length;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + viewButtons.length) % viewButtons.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = viewButtons.length - 1;
      if (next === null) return;
      event.preventDefault();
      const target = viewButtons[next];
      setReportView(target.getAttribute("data-report-view"));
      target.focus();
    };
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
    if (!scope) { void uiAlert("Seleziona entrambe le date (Da / A) o un turno."); return; }
    showToast(`${name}: ${scope.label}`);
    window.location.href = `${endpoint}${scope.qs}`;
  }

  btn.onclick = () => download("/api/reports/export.csv", "CSV prodotti");
  if (txBtn) txBtn.onclick = () => download("/api/reports/transactions.csv", "CSV transazioni");
  if (itemsBtn) itemsBtn.onclick = () => download("/api/reports/items.csv", "CSV righe vendute");

  if (createBackupBtn) {
    createBackupBtn.onclick = async () => {
      const previousLabel = createBackupBtn.textContent;
      createBackupBtn.disabled = true;
      createBackupBtn.textContent = "Creazione in corso…";
      try {
        const created = await api("/api/reports/backup", { method: "POST" });
        const link = document.createElement("a");
        link.href = created.download_url;
        link.download = created.backup_name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        showToast(`Backup creato • ${created.backup_name}`);
      } catch (error) {
        await uiError(error);
      } finally {
        createBackupBtn.disabled = false;
        createBackupBtn.textContent = previousLabel;
      }
    };
  }

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
        await uiAlert("Il file supera il limite di 100 MB.");
        return;
      }

      const confirmation = await uiPrompt(
        "Ripristina backup",
        `Scrivi RIPRISTINA per sostituire i dati correnti con ${file.name}`
      );
      if (confirmation !== "RIPRISTINA") {
        if (confirmation !== null) await uiAlert("Conferma non corretta: ripristino annullato.");
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

        await uiAlert(
          `Backup di sicurezza creato: ${data.safety_backup}`,
          "Ripristino completato",
          "success"
        );
        location.reload();
      } catch (err) {
        await uiError(err);
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
  const loadMoreBtn = document.querySelector("#loadMoreSalesBtn");
  if (!listEl) return;

  const PAY_LABEL = { cash: "Contanti", card: "Carta", other: "Altro" };
  let loadedSales = [];
  let nextCursor = null;
  let loading = false;

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 1700);
  }

  function saleCard(sale) {
    const items = (sale.items || []).map(it => {
      const options = (it.options || []).map(option => option.name).join(", ");
      return `${it.qty}× ${escapeHtml(it.name)}${options ? ` (${escapeHtml(options)})` : ""}${it.note ? ` — ${escapeHtml(it.note)}` : ""}`;
    }).join("<br>");
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
          ${sale.note ? `<div class="small sale-void-reason">Nota comanda: ${escapeHtml(sale.note)}</div>` : ""}
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

  async function refresh({ append = false } = {}) {
    if (loading) return;
    loading = true;
    const params = filtersQuery();
    params.set("paginated", "1");
    if (append && nextCursor) params.set("cursor", String(nextCursor));
    if (loadMoreBtn) {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = append ? "Caricamento…" : "Carica altre vendite";
    }
    try {
      const page = await api(`/api/sales?${params.toString()}`);
      loadedSales = append ? [...loadedSales, ...page.sales] : page.sales;
      nextCursor = page.next_cursor;
      const filtered = [...params.keys()].some(key => !["limit", "paginated", "cursor"].includes(key));
      if (listTitle) {
        listTitle.textContent = filtered
          ? `Risultati (${loadedSales.length}${nextCursor ? "+" : ""})`
          : "Vendite recenti";
      }
      listEl.innerHTML = loadedSales.length
        ? loadedSales.map(saleCard).join("")
        : "<div class='empty-state'>Nessuna vendita trovata con questi filtri.</div>";
      if (loadMoreBtn) loadMoreBtn.hidden = !nextCursor;
    } finally {
      loading = false;
      if (loadMoreBtn) {
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = "Carica altre vendite";
      }
    }
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
        await uiError(err);
      } finally {
        await refresh().catch(uiError);
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
      await uiError(err);
    }
  });

  refreshBtn?.addEventListener("click", () => refresh().catch(uiError));
  loadMoreBtn?.addEventListener("click", () => refresh({ append: true }).catch(uiError));
  toggleFiltersBtn?.addEventListener("click", () => {
    setAdvancedFilters(toggleFiltersBtn.getAttribute("aria-expanded") !== "true");
  });
  if (filtersForm) filtersForm.onsubmit = (e) => {
    e.preventDefault();
    syncFilterSummary();
    refresh().catch(uiError);
  };
  if (filtersForm) filtersForm.onchange = syncFilterSummary;
  if (resetBtn) resetBtn.onclick = () => {
    filtersForm?.reset();
    setAdvancedFilters(false);
    syncFilterSummary();
    refresh().catch(uiError);
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
    await uiError(e);
  }
});
