const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  isDownloadableBackupName,
  pruneBackupFiles,
} = require("../src/backup-files");

test("la whitelist ammette backup operativi e pre-migrazione senza traversal", () => {
  assert.equal(isDownloadableBackupName("eventorder-backup-20260720-120000.sqlite", "eventorder"), true);
  assert.equal(isDownloadableBackupName("eventorder-pre-restore-20260720-120000-2.sqlite", "eventorder"), true);
  assert.equal(
    isDownloadableBackupName("eventorder-pre-migration-v4-to-v11-20260720-120000.sqlite", "eventorder"),
    true
  );
  assert.equal(isDownloadableBackupName("../eventorder-backup-20260720-120000.sqlite", "eventorder"), false);
  assert.equal(isDownloadableBackupName("eventorder-estraneo-20260720-120000.sqlite", "eventorder"), false);
});

test("la rotazione usa quote separate e conserva file SQLite sconosciuti", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-backups-"));
  const names = [
    "eventorder-backup-20260101-000000.sqlite",
    "eventorder-pre-restore-20260201-000000.sqlite",
    "eventorder-backup-20260301-000000.sqlite",
    "eventorder-pre-migration-v4-to-v11-20260101-000000.sqlite",
    "eventorder-pre-migration-v4-to-v11-20260201-000000.sqlite",
    "eventorder-pre-migration-v4-to-v11-20260301-000000.sqlite",
    "database-importante.sqlite",
  ];

  try {
    names.forEach((name, index) => {
      const filePath = path.join(tempDir, name);
      fs.writeFileSync(filePath, name);
      fs.utimesSync(filePath, index + 1, index + 1);
    });

    const removed = pruneBackupFiles(tempDir, {
      slug: "eventorder",
      keepOperational: 2,
      keepPreMigration: 2,
    });

    assert.deepEqual(removed.sort(), [
      "eventorder-backup-20260101-000000.sqlite",
      "eventorder-pre-migration-v4-to-v11-20260101-000000.sqlite",
    ]);
    assert.equal(fs.existsSync(path.join(tempDir, "database-importante.sqlite")), true);
    assert.equal(fs.existsSync(path.join(tempDir, "eventorder-backup-20260301-000000.sqlite")), true);
    assert.equal(fs.existsSync(path.join(tempDir, "eventorder-pre-migration-v4-to-v11-20260301-000000.sqlite")), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
