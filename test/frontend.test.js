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
  const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const checkoutHtml = fs.readFileSync(path.join(__dirname, "..", "public", "cassa.html"), "utf8");

  assert.match(checkoutHtml, /id="soldOutHint"/);
  assert.match(appSource, /setAttribute\("aria-describedby", "soldOutHint"\)/);
  assert.match(appSource, /setAttribute\("aria-keyshortcuts", "Shift\+Enter"\)/);
  assert.match(appSource, /event\.key !== "Enter" \|\| !event\.shiftKey/);
  assert.match(appSource, /event\.stopPropagation\(\)/);
});

test("la cassa conserva il carrello, riconcilia i prezzi e gestisce le comande sospese", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
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

  assert.match(source, /disposePageUi\(\);\s*curMain\.replaceWith\(newMain\)/);
  assert.match(source, /modalStack\.length = 0/);
  assert.match(source, /document\.body\.style\.overflow = ""/);
  assert.match(source, /eventorder-pending-checkout-v1/);
  assert.match(source, /eventorder-pending-movement-v1/);
  assert.match(source, /eventorder-pending-suspend-v1/);
  assert.match(source, /eventorder-pending-resume-v1/);
  assert.match(source, /restoreCheckoutUi\(\)/);
});
