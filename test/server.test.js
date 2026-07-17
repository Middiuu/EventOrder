const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { once } = require("events");
const Database = require("better-sqlite3");

const PROJECT_ROOT = path.join(__dirname, "..");

test("SIGTERM arresta il server con checkpoint e chiusura pulita di SQLite", { timeout: 15000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-server-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  let child;
  let stdout = "";
  let stderr = "";

  try {
    child = spawn(process.execPath, [path.join(PROJECT_ROOT, "src", "server.js")], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        POS_DB_PATH: dbPath,
        POS_SEED_DEMO: "0",
        HOST: "127.0.0.1",
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server non avviato. stderr: ${stderr}`)), 8000);
      const inspect = () => {
        if (!stdout.includes("EventOrder avviato")) return;
        clearTimeout(timeout);
        resolve();
      };
      child.stdout.on("data", inspect);
      child.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      inspect();
    });

    assert.equal(child.kill("SIGTERM"), true);
    const [code, signal] = await once(child, "exit");
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /arresto ordinato/);
    assert.equal(fs.existsSync(`${dbPath}-wal`), false);
    assert.equal(fs.existsSync(`${dbPath}-shm`), false);

    const verified = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(verified.pragma("integrity_check"), [{ integrity_check: "ok" }]);
      assert.equal(verified.pragma("journal_mode", { simple: true }), "wal");
    } finally {
      verified.close();
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => {});
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
