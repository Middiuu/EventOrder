const fs = require("fs");
const path = require("path");
const { fsyncDirectory } = require("./fs-durability");

function createDatabaseRecovery(databasePath) {
  const dbPath = path.resolve(databasePath);
  const restoreMarkerPath = `${dbPath}.restore-state.json`;
  const migrationMarkerPath = `${dbPath}.migration-state.json`;
  const sidecarPaths = Object.freeze([`${dbPath}-wal`, `${dbPath}-shm`]);

  // I sidecar appartengono al file corrente: rimuoverli solo senza connessioni aperte.
  function removeDatabaseSidecars() {
    for (const sidecarPath of sidecarPaths) {
      if (!fs.existsSync(sidecarPath)) continue;
      const stat = fs.lstatSync(sidecarPath);
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw new Error(`Sidecar SQLite non valido: ${sidecarPath}`);
      }
      fs.unlinkSync(sidecarPath);
    }
  }

  function verifiedSafetyBackup(safetyBackupPath) {
    const resolved = path.resolve(String(safetyBackupPath || ""));
    const backupsDir = path.resolve(path.dirname(dbPath), "backups");
    if (path.dirname(resolved) !== backupsDir) {
      throw new Error("Percorso del backup di sicurezza non valido");
    }
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Backup di sicurezza non valido");
    }
    return resolved;
  }

  function writeMarker(markerPath, payload) {
    const tempPath = `${markerPath}.${process.pid}.tmp`;
    const fd = fs.openSync(tempPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ ...payload, createdAt: new Date().toISOString() }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, markerPath);
    fsyncDirectory(path.dirname(dbPath));
  }

  function readMarker(markerPath, label) {
    try {
      return JSON.parse(fs.readFileSync(markerPath, "utf8"));
    } catch {
      throw new Error(
        `${label} interrotto: marker non leggibile (${markerPath}). Intervento manuale richiesto.`
      );
    }
  }

  function restoreSafetyBackup(safetyBackupPath, recoveryKind) {
    const verified = verifiedSafetyBackup(safetyBackupPath);
    const recoveryPath = `${dbPath}.${recoveryKind}-recovery-${process.pid}-${Date.now()}`;
    fs.copyFileSync(verified, recoveryPath, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(recoveryPath, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    removeDatabaseSidecars();
    fs.renameSync(recoveryPath, dbPath);
  }

  function completeMarker(markerPath) {
    fs.rmSync(markerPath, { force: true });
    fsyncDirectory(path.dirname(dbPath));
  }

  function writeRestoreMarker(safetyBackupPath) {
    writeMarker(restoreMarkerPath, {
      safetyBackupPath: verifiedSafetyBackup(safetyBackupPath),
    });
  }

  function recoverFromRestoreMarker() {
    if (!fs.existsSync(restoreMarkerPath)) return false;
    const marker = readMarker(restoreMarkerPath, "Ripristino");
    restoreSafetyBackup(marker.safetyBackupPath, "restore");
    completeMarker(restoreMarkerPath);
    console.warn("Rilevato un ripristino interrotto: recuperato automaticamente il backup pre-restore.");
    return true;
  }

  function writeMigrationMarker(safetyBackupPath, fromVersion, toVersion) {
    writeMarker(migrationMarkerPath, {
      safetyBackupPath: verifiedSafetyBackup(safetyBackupPath),
      fromVersion,
      toVersion,
    });
  }

  function recoverFromMigrationMarker() {
    if (!fs.existsSync(migrationMarkerPath)) return false;
    const marker = readMarker(migrationMarkerPath, "Migrazione");
    if (!Number.isSafeInteger(marker.fromVersion) || !Number.isSafeInteger(marker.toVersion)) {
      throw new Error("Migrazione interrotta: versioni del marker non valide. Intervento manuale richiesto.");
    }
    restoreSafetyBackup(marker.safetyBackupPath, "migration");
    completeMarker(migrationMarkerPath);
    console.warn(
      `Rilevata una migrazione v${marker.fromVersion}->v${marker.toVersion} interrotta: ` +
      "recuperato automaticamente il backup pre-migrazione."
    );
    return true;
  }

  // Compatibilita' col restore precedente: recupera l'originale rimasto tra i rename.
  function recoverLegacyRestoreOriginal() {
    if (fs.existsSync(dbPath)) return false;
    const dir = path.dirname(dbPath);
    const prefix = `${path.basename(dbPath)}.restore-original-`;
    const candidates = fs.readdirSync(dir)
      .filter(name => name.startsWith(prefix))
      .map(name => {
        const candidatePath = path.join(dir, name);
        const stat = fs.lstatSync(candidatePath);
        return stat.isFile() && !stat.isSymbolicLink()
          ? { candidatePath, mtimeMs: stat.mtimeMs }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (candidates.length === 0) return false;

    removeDatabaseSidecars();
    fs.renameSync(candidates[0].candidatePath, dbPath);
    fsyncDirectory(dir);
    console.warn("Recuperato automaticamente un database lasciato da un restore interrotto.");
    return true;
  }

  function recoverAtStartup() {
    if (fs.existsSync(restoreMarkerPath) && fs.existsSync(migrationMarkerPath)) {
      throw new Error("Stato ambiguo: presenti marker di restore e migrazione. Intervento manuale richiesto.");
    }
    recoverFromRestoreMarker();
    recoverFromMigrationMarker();
    recoverLegacyRestoreOriginal();
  }

  return Object.freeze({
    completeMigrationMarker: () => completeMarker(migrationMarkerPath),
    completeRestoreMarker: () => completeMarker(restoreMarkerPath),
    migrationMarkerPath,
    recoverAtStartup,
    recoverFromRestoreMarker,
    restoreMarkerPath,
    sidecarPaths,
    writeMigrationMarker,
    writeRestoreMarker,
  });
}

module.exports = { createDatabaseRecovery };
