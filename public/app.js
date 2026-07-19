/* global initCassa, initProdotti */
/* exported eurToCents, withFormSubmitLock */
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
// Il controller della cassa e' caricato da /cassa-controller.js.
// --------------------
// Prodotti / Report / Export
// Il controller del catalogo e' caricato da /products-controller.js.
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
