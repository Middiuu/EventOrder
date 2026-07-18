const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");

function lineCount(relativePath) {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8");
  return source.split("\n").length;
}

test("i router backend separati rispettano il ratchet di dimensione", () => {
  const limits = new Map([
    ["src/routes/reports.js", 250],
    ["src/routes/database-maintenance.js", 300],
    ["src/routes/products.js", 250],
    ["src/routes/sessions.js", 250],
    ["src/routes/sales.js", 250],
  ]);

  for (const [file, maximum] of limits) {
    const actual = lineCount(file);
    assert.ok(actual <= maximum, `${file}: ${actual} righe, massimo consentito ${maximum}`);
  }
});
