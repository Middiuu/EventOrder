const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("il frontend usa dialoghi accessibili al posto di alert, confirm e prompt nativi", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

  assert.doesNotMatch(source, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.match(source, /role", tone \? "alertdialog" : "dialog"/);
});

test("l'azione esaurito espone istruzioni e alternativa da tastiera", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "cassa-controller.js"), "utf8");
  const checkoutHtml = fs.readFileSync(path.join(__dirname, "..", "public", "cassa.html"), "utf8");

  assert.match(checkoutHtml, /id="soldOutHint"/);
  assert.match(appSource, /setAttribute\("aria-describedby", "soldOutHint"\)/);
  assert.match(appSource, /setAttribute\("aria-keyshortcuts", "Shift\+Enter"\)/);
  assert.match(appSource, /event\.key !== "Enter" \|\| !event\.shiftKey/);
  assert.match(appSource, /event\.stopPropagation\(\)/);
});

test("la cassa conserva il carrello, riconcilia i prezzi e gestisce le comande sospese", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "cassa-controller.js"), "utf8");
  const checkoutHtml = fs.readFileSync(path.join(__dirname, "..", "public", "cassa.html"), "utf8");

  assert.match(appSource, /eventorder-current-cart-v1/);
  assert.match(appSource, /expected_unit_price_cents: it\.unit_price_cents/);
  assert.match(appSource, /reconcileCartWithCatalog\(\)/);
  assert.match(appSource, /api\("\/api\/carts"\)/);
  assert.match(checkoutHtml, /id="suspendCartBtn"/);
  assert.match(checkoutHtml, /id="suspendedCartsModal"[^>]*hidden/);
  assert.match(checkoutHtml, /aria-labelledby="suspendedCartsTitle"/);
  assert.match(checkoutHtml, /id="itemOptionsModal"[^>]*hidden/);
  assert.match(checkoutHtml, /id="orderNote"/);
  assert.match(appSource, /selected_option_value_ids/);
});

test("la CSP puo' bloccare gli script inline senza interrompere le pagine", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const htmlFiles = fs.readdirSync(publicDir).filter(file => file.endsWith(".html"));

  for (const file of htmlFiles) {
    const source = fs.readFileSync(path.join(publicDir, file), "utf8");
    assert.doesNotMatch(source, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file} contiene uno script inline`);
    assert.doesNotMatch(source, /\son[a-z]+\s*=/i, `${file} contiene un event handler inline`);
    assert.match(source, /<script src="\/theme-init\.js"><\/script>/);
  }
});

test("gli initializer di pagina sono isolati fra loro", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

  assert.match(source, /const initializers = \[/);
  assert.match(source, /for \(const \[name, initialize\] of initializers\)/);
  assert.match(source, /await initialize\(\)/);
  assert.match(source, /Inizializzazione \$\{name\} non riuscita/);
});

test("navigazione e retry persistenti mantengono i guardrail verificati in browser", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const cassaSource = fs.readFileSync(path.join(__dirname, "..", "public", "cassa-controller.js"), "utf8");

  assert.match(source, /disposePageUi\(\);\s*curMain\.replaceWith\(newMain\)/);
  assert.match(source, /modalStack\.length = 0/);
  assert.match(source, /document\.body\.style\.overflow = ""/);
  assert.match(cassaSource, /eventorder-pending-checkout-v1/);
  assert.match(cassaSource, /eventorder-pending-movement-v1/);
  assert.match(cassaSource, /eventorder-pending-suspend-v1/);
  assert.match(cassaSource, /eventorder-pending-resume-v1/);
  assert.match(cassaSource, /restoreCheckoutUi\(\)/);
  assert.match(source, /async function withFormSubmitLock/);
  assert.match(source, /form\.dataset\.submitting === "true"/);
  assert.match(source, /form\.setAttribute\("aria-busy", "true"\)/);
});

test("toast, tab report e riordino prodotti hanno alternative accessibili", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const appSource = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  const productSource = fs.readFileSync(path.join(publicDir, "products-controller.js"), "utf8");
  for (const file of ["cassa.html", "products.html", "sales.html", "reports.html"]) {
    const html = fs.readFileSync(path.join(publicDir, file), "utf8");
    assert.match(html, /id="toast"[^>]*role="status"[^>]*aria-live="polite"/);
  }
  const reports = fs.readFileSync(path.join(publicDir, "reports.html"), "utf8");
  assert.match(reports, /role="tab"[^>]*aria-controls="reportPanelSummary"/);
  assert.match(reports, /role="tabpanel"[^>]*aria-labelledby="reportTabSummary"/);
  assert.match(appSource, /event\.key === "ArrowRight"/);
  assert.match(productSource, /data-move-product/);
  assert.match(productSource, /aria-label="Sposta \$\{escapeHtml\(p\.name\)\} in alto"/);
});

test("gli importi usano locale e codice valuta configurati", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(source, /new Intl\.NumberFormat\(locale/);
  assert.match(source, /currency: APP_CONFIG\.currencyCode|const currency = APP_CONFIG\.currencyCode/);
  assert.doesNotMatch(source, /\(cents \/ 100\)\.toFixed\(2\)\.replace/);
});

test("il feedback toast usa una sola implementazione condivisa", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const sources = ["app.js", "cassa-controller.js", "products-controller.js"]
    .map(file => fs.readFileSync(path.join(publicDir, file), "utf8"));
  assert.equal(sources.reduce((count, source) => count + (source.match(/function showToast/g) || []).length, 0), 1);
});

test("il controller prodotti e' separato e caricato da ogni shell SPA", () => {
  const publicDir = path.join(__dirname, "..", "public");
  const appSource = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  const controller = fs.readFileSync(path.join(publicDir, "products-controller.js"), "utf8");
  const cassaController = fs.readFileSync(path.join(publicDir, "cassa-controller.js"), "utf8");
  assert.doesNotMatch(appSource, /async function initProdotti/);
  assert.doesNotMatch(appSource, /async function initCassa/);
  assert.match(controller, /async function initProdotti/);
  assert.match(cassaController, /async function initCassa/);
  for (const file of ["cassa.html", "products.html", "sales.html", "reports.html"]) {
    const html = fs.readFileSync(path.join(publicDir, file), "utf8");
    assert.match(html, /<script src="\/cassa-controller\.js"><\/script>\s*<script src="\/products-controller\.js"><\/script>\s*<script src="\/app\.js"><\/script>/);
  }
});
