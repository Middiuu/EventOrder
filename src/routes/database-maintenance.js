const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const {
  db,
  DB_PATH,
  getOpenSession,
  validateRestoreCandidate,
  restoreDatabaseFromFile,
} = require("../db");
const { clearAuthenticationState } = require("../auth");
const { config } = require("../config");
const { isDownloadableBackupName, pruneBackupFiles } = require("../backup-files");
const {
  beginBackup,
  endBackup,
  beginRestore,
  endRestore,
} = require("../maintenance");

const router = express.Router();
const RESTORE_MAX_BYTES = 100 * 1024 * 1024;

function pad2(number) {
  return String(number).padStart(2, "0");
}

function backupStamp(now = new Date()) {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-` +
    `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

function getBackupsDir() {
  const backupsDir = path.join(path.dirname(DB_PATH), "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  return backupsDir;
}

function pruneBackups(backupsDir, protectedName) {
  try {
    pruneBackupFiles(backupsDir, {
      slug: config.SLUG,
      keepOperational: config.BACKUP_KEEP,
      keepPreMigration: config.PRE_MIGRATION_BACKUP_KEEP,
      protectedNames: [protectedName],
    });
  } catch (error) {
    console.warn("Rotazione backup non riuscita:", error.message);
  }
}

async function createDatabaseBackup(kind = "backup") {
  if (!fs.existsSync(DB_PATH)) {
    const error = new Error("Database non trovato");
    error.status = 404;
    error.publicMessage = error.message;
    throw error;
  }

  const backupsDir = getBackupsDir();
  const base = `${config.SLUG}-${kind}-${backupStamp()}`;
  let backupName = `${base}.sqlite`;
  let suffix = 2;
  while (fs.existsSync(path.join(backupsDir, backupName))) {
    backupName = `${base}-${suffix++}.sqlite`;
  }
  const backupPath = path.join(backupsDir, backupName);

  await db.backup(backupPath);
  pruneBackups(backupsDir, backupName);
  return {
    backupName,
    backupPath,
    sizeBytes: fs.statSync(backupPath).size,
  };
}

router.post("/backup", async (req, res, next) => {
  if (!beginBackup()) {
    res.setHeader("Retry-After", "2");
    return res.status(503).json({
      error: "Backup o ripristino del database in corso. Riprova tra pochi secondi.",
    });
  }
  try {
    const { backupName, sizeBytes } = await createDatabaseBackup();
    res.status(201).json({
      backup_name: backupName,
      size_bytes: sizeBytes,
      download_url: `/api/reports/backup/${encodeURIComponent(backupName)}`,
    });
  } catch (error) {
    next(error);
  } finally {
    endBackup();
  }
});

router.get("/backup", (req, res) => {
  res.setHeader("Allow", "POST");
  res.status(405).json({ error: "Usa POST per creare un nuovo backup" });
});

router.get("/backup/:filename", async (req, res, next) => {
  const filename = String(req.params.filename || "");
  if (!isDownloadableBackupName(filename, config.SLUG)) {
    return res.status(400).json({ error: "Nome backup non valido" });
  }

  const backupsDir = getBackupsDir();
  const backupPath = path.resolve(backupsDir, filename);
  if (path.dirname(backupPath) !== backupsDir) {
    return res.status(400).json({ error: "Percorso backup non valido" });
  }
  let stat;
  try {
    stat = fs.lstatSync(backupPath);
  } catch (error) {
    if (error.code === "ENOENT") return res.status(404).json({ error: "Backup non trovato" });
    return next(error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return res.status(400).json({ error: "Backup non valido" });
  }

  res.setHeader("Content-Type", "application/x-sqlite3");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  try {
    await pipeline(fs.createReadStream(backupPath), res);
  } catch (error) {
    if (!req.destroyed && !res.destroyed) next(error);
  }
});

function restoreUploadError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  return error;
}

async function streamRestoreUpload(req, res, next) {
  const contentType = String(req.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
  const allowedTypes = new Set([
    "application/octet-stream",
    "application/x-sqlite3",
    "application/vnd.sqlite3",
  ]);
  if (!allowedTypes.has(contentType)) {
    return next(restoreUploadError(415, "Formato del backup non supportato"));
  }

  const declaredLength = Number(req.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > RESTORE_MAX_BYTES) {
    return next(restoreUploadError(413, "Il backup supera il limite di 100 MB"));
  }

  const candidatePath = `${DB_PATH}.restore-upload-${process.pid}-${crypto.randomUUID()}`;
  let received = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > RESTORE_MAX_BYTES) {
        callback(restoreUploadError(413, "Il backup supera il limite di 100 MB"));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      req,
      limiter,
      fs.createWriteStream(candidatePath, { flags: "wx", mode: 0o600 })
    );
    if (received === 0) throw restoreUploadError(400, "Seleziona un file di backup SQLite");
    req.restoreCandidatePath = candidatePath;
    next();
  } catch (error) {
    fs.rmSync(candidatePath, { force: true });
    next(error);
  }
}

function ensureRestoreCapacity(candidatePath) {
  if (typeof fs.statfsSync !== "function") return;
  const filesystem = fs.statfsSync(path.dirname(DB_PATH));
  const available = Number(filesystem.bavail) * Number(filesystem.bsize);
  const candidateSize = fs.statSync(candidatePath).size;
  const currentSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  const reserve = 10 * 1024 * 1024;
  if (available < candidateSize + currentSize + reserve) {
    throw restoreUploadError(507, "Spazio su disco insufficiente per completare il ripristino in sicurezza");
  }
}

function requireRestoreConfirmation(req, res, next) {
  if (req.get("X-EventOrder-Restore") !== "RESTORE") {
    return res.status(400).json({ error: "Conferma di ripristino mancante" });
  }
  next();
}

function acquireRestoreLock(req, res, next) {
  if (!beginRestore()) {
    return res.status(409).json({
      error: "Attendi la conclusione del backup o ripristino gia' in corso",
    });
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    endRestore();
  };
  res.once("finish", release);
  res.once("close", release);
  next();
}

function requireClosedSession(req, res, next) {
  if (getOpenSession()) {
    return res.status(409).json({ error: "Chiudi la cassa prima di ripristinare un backup" });
  }
  next();
}

router.post(
  "/restore",
  requireRestoreConfirmation,
  acquireRestoreLock,
  requireClosedSession,
  streamRestoreUpload,
  async (req, res, next) => {
    let candidatePath = req.restoreCandidatePath;
    try {
      ensureRestoreCapacity(candidatePath);
      const inspected = validateRestoreCandidate(candidatePath);
      const safety = await createDatabaseBackup("pre-restore");
      restoreDatabaseFromFile(candidatePath, safety.backupPath);
      // Un backup non deve riattivare cookie o blocchi login appartenenti a
      // una precedente istanza del database.
      clearAuthenticationState();
      candidatePath = null;

      res.json({
        ok: true,
        restored: inspected,
        safety_backup: safety.backupName,
      });
    } catch (error) {
      next(error);
    } finally {
      if (candidatePath) fs.rmSync(candidatePath, { force: true });
    }
  }
);

module.exports = router;
