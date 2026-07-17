const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("il frontend usa dialoghi accessibili al posto di alert, confirm e prompt nativi", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

  assert.doesNotMatch(source, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.match(source, /role\", tone \? \"alertdialog\" : \"dialog\"/);
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
