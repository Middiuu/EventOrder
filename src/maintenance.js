let restoreInProgress = false;
let backupInProgress = false;

function beginBackup() {
  if (restoreInProgress || backupInProgress) return false;
  backupInProgress = true;
  return true;
}

function endBackup() {
  backupInProgress = false;
}

function beginRestore() {
  if (restoreInProgress || backupInProgress) return false;
  restoreInProgress = true;
  return true;
}

function endRestore() {
  restoreInProgress = false;
}

// Durante un restore nessuna route che usa il DB puo' proseguire: anche una
// lettura o un backup online potrebbero conservare la vecchia connessione
// mentre restoreDatabaseFromFile la chiude e la sostituisce.
function maintenanceMiddleware(req, res, next) {
  if (!restoreInProgress) return next();
  res.setHeader("Retry-After", "2");
  return res.status(503).json({
    error: "Ripristino del database in corso. Riprova tra pochi secondi.",
  });
}

module.exports = {
  beginBackup,
  endBackup,
  beginRestore,
  endRestore,
  maintenanceMiddleware,
};
