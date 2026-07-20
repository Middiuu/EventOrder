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
      ALLOWED_HOSTS: "",
      PUBLIC_ORIGIN: "",
      TRUST_PROXY: "",
      WEB_CONCURRENCY: "",
      NODE_UNIQUE_ID: "",
      BACKUP_KEEP: "",
      PRE_MIGRATION_BACKUP_KEEP: "",
      AUDIT_RETENTION_DAYS: "",
      OPERATION_REQUEST_RETENTION_DAYS: "",
      ...env,
    },
    encoding: "utf8",
  });
}

test("valida porta, retention, locale e codice valuta", () => {
  const valid = loadConfig({
    PORT: "0",
    BACKUP_KEEP: "0",
    PRE_MIGRATION_BACKUP_KEEP: "2",
    AUDIT_RETENTION_DAYS: "0",
    OPERATION_REQUEST_RETENTION_DAYS: "45",
    LOCALE: "en-GB",
    CURRENCY_CODE: "gbp",
  });
  assert.equal(valid.status, 0, valid.stderr);
  const config = JSON.parse(valid.stdout);
  assert.equal(config.PORT, 0);
  assert.equal(config.BACKUP_KEEP, 0);
  assert.equal(config.PRE_MIGRATION_BACKUP_KEEP, 2);
  assert.equal(config.AUDIT_RETENTION_DAYS, 0);
  assert.equal(config.OPERATION_REQUEST_RETENTION_DAYS, 45);
  assert.equal(config.CURRENCY_CODE, "GBP");

  for (const [name, value, message] of [
    ["PORT", "abc", /PORT deve essere un numero intero/],
    ["PORT", "65536", /PORT deve essere compreso/],
    ["BACKUP_KEEP", "-1", /BACKUP_KEEP deve essere un numero intero/],
    ["PRE_MIGRATION_BACKUP_KEEP", "10001", /PRE_MIGRATION_BACKUP_KEEP deve essere compreso/],
    ["AUDIT_RETENTION_DAYS", "-1", /AUDIT_RETENTION_DAYS deve essere un numero intero/],
    ["OPERATION_REQUEST_RETENTION_DAYS", "abc", /OPERATION_REQUEST_RETENTION_DAYS deve essere un numero intero/],
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

test("valida host, origin pubblico e proxy attendibile", () => {
  const valid = loadConfig({
    ALLOWED_HOSTS: "pos.example.test,192.168.1.20",
    PUBLIC_ORIGIN: "https://pos.example.test",
    TRUST_PROXY: "loopback",
  });
  assert.equal(valid.status, 0, valid.stderr);
  const config = JSON.parse(valid.stdout);
  assert.deepEqual(config.ALLOWED_HOSTS, ["pos.example.test", "192.168.1.20"]);
  assert.equal(config.PUBLIC_ORIGIN, "https://pos.example.test");
  assert.equal(config.TRUST_PROXY, "loopback");

  for (const [name, value, message] of [
    ["ALLOWED_HOSTS", "*.example.test", /ALLOWED_HOSTS contiene un host non valido/],
    ["ALLOWED_HOSTS", "pos..example.test", /ALLOWED_HOSTS contiene un host non valido/],
    ["PUBLIC_ORIGIN", "https://pos.example.test/path", /PUBLIC_ORIGIN deve essere un origin HTTP\/HTTPS/],
    ["PUBLIC_ORIGIN", "file:///tmp/pos", /PUBLIC_ORIGIN deve essere un origin HTTP\/HTTPS/],
    ["TRUST_PROXY", "true", /TRUST_PROXY ammette solo/],
  ]) {
    const result = loadConfig({ [name]: value });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
});
