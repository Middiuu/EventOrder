const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const configPath = path.join(PROJECT_ROOT, "src", "config.js");

function loadConfig(env) {
  return spawnSync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)}).config))`], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      APP_PIN: "",
      WEB_CONCURRENCY: "",
      NODE_UNIQUE_ID: "",
      ...env,
    },
    encoding: "utf8",
  });
}

test("valida porta, retention, locale e codice valuta", () => {
  const valid = loadConfig({ PORT: "0", BACKUP_KEEP: "0", LOCALE: "en-GB", CURRENCY_CODE: "gbp" });
  assert.equal(valid.status, 0, valid.stderr);
  const config = JSON.parse(valid.stdout);
  assert.equal(config.PORT, 0);
  assert.equal(config.BACKUP_KEEP, 0);
  assert.equal(config.CURRENCY_CODE, "GBP");

  for (const [name, value, message] of [
    ["PORT", "abc", /PORT deve essere un numero intero/],
    ["PORT", "65536", /PORT deve essere compreso/],
    ["BACKUP_KEEP", "-1", /BACKUP_KEEP deve essere un numero intero/],
    ["CURRENCY_CODE", "NOPE", /LOCALE o CURRENCY_CODE non validi/],
  ]) {
    const result = loadConfig({ [name]: value });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
});

test("rifiuta configurazioni multi-processo incompatibili con SQLite locale", () => {
  const result = loadConfig({ WEB_CONCURRENCY: "2" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /un solo processo/);
});
