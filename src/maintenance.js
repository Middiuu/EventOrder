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

function getMaintenanceState() {
  return {
    backupInProgress,
    restoreInProgress,
  };
}

function acquireRestoreLock(req, res, next) {
  if (!beginRestore()) {
    return res.status(409).json({
      error: "Attendi la conclusione del backup o ripristino gia' in corso",
    });
  }

  let released = false;
  req.releaseRestoreLock = () => {
    if (released) return;
    released = true;
    endRestore();
  };

  // `finish` e' un fallback per risposte concluse prima dell'handler finale.
  // Non rilasciare su `close`: il client puo' disconnettersi mentre il lavoro
  // asincrono di restore continua ancora sul database.
  res.once("finish", req.releaseRestoreLock);
  next();
}

function releaseRestoreLock(req) {
  req.releaseRestoreLock?.();
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
  getMaintenanceState,
  acquireRestoreLock,
  releaseRestoreLock,
  maintenanceMiddleware,
};
