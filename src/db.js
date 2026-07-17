const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { config } = require("./config");

const DB_PATH = process.env.POS_DB_PATH
  ? path.resolve(process.env.POS_DB_PATH)
  : path.join(__dirname, "..", "pos.sqlite");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");
const DB_SCHEMA_VERSION = 8;
const DB_BUSY_TIMEOUT_MS = 5000;
const RESTORE_MARKER_PATH = `${DB_PATH}.restore-state.json`;
const DB_SIDECAR_PATHS = [`${DB_PATH}-wal`, `${DB_PATH}-shm`];

function fsyncDirectory(dirPath) {
  let fd;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } catch {
    // Alcuni filesystem non consentono fsync sulle directory. I file sono
    // comunque sincronizzati singolarmente prima di ogni rename.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// I sidecar WAL appartengono esattamente al file DB corrente. Li rimuoviamo
// solo al boot, prima di recuperare un database da un marker di restore e
// quando nessuna connessione di questo processo e' ancora stata aperta.
function removeDatabaseSidecars() {
  for (const sidecarPath of DB_SIDECAR_PATHS) {
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
  const backupsDir = path.resolve(path.dirname(DB_PATH), "backups");
  if (path.dirname(resolved) !== backupsDir) {
    throw new Error("Percorso del backup di sicurezza non valido");
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Backup di sicurezza non valido");
  }
  return resolved;
}

function writeRestoreMarker(safetyBackupPath) {
  const verified = verifiedSafetyBackup(safetyBackupPath);
  const tempPath = `${RESTORE_MARKER_PATH}.${process.pid}.tmp`;
  const fd = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ safetyBackupPath: verified, createdAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, RESTORE_MARKER_PATH);
  fsyncDirectory(path.dirname(DB_PATH));
}

function recoverFromRestoreMarker() {
  if (!fs.existsSync(RESTORE_MARKER_PATH)) return false;

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(RESTORE_MARKER_PATH, "utf8"));
  } catch {
    throw new Error(
      `Ripristino interrotto: marker non leggibile (${RESTORE_MARKER_PATH}). Intervento manuale richiesto.`
    );
  }
  const safetyBackupPath = verifiedSafetyBackup(marker.safetyBackupPath);
  const recoveryPath = `${DB_PATH}.restore-recovery-${process.pid}-${Date.now()}`;
  fs.copyFileSync(safetyBackupPath, recoveryPath, fs.constants.COPYFILE_EXCL);

  const fd = fs.openSync(recoveryPath, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  removeDatabaseSidecars();
  fs.renameSync(recoveryPath, DB_PATH);
  fs.rmSync(RESTORE_MARKER_PATH, { force: true });
  fsyncDirectory(path.dirname(DB_PATH));
  console.warn("Rilevato un ripristino interrotto: recuperato automaticamente il backup pre-restore.");
  return true;
}

// Compatibilita' con la prima implementazione del restore: se un crash e'
// avvenuto fra i due rename, recupera l'originale invece di creare un DB vuoto.
function recoverLegacyRestoreOriginal() {
  if (fs.existsSync(DB_PATH)) return false;
  const dir = path.dirname(DB_PATH);
  const prefix = `${path.basename(DB_PATH)}.restore-original-`;
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
  fs.renameSync(candidates[0].candidatePath, DB_PATH);
  fsyncDirectory(dir);
  console.warn("Recuperato automaticamente un database lasciato da un restore interrotto.");
  return true;
}

recoverFromRestoreMarker();
recoverLegacyRestoreOriginal();

function openConnection() {
  const next = new Database(DB_PATH);
  next.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
  next.pragma("foreign_keys = ON");
  return next;
}

let connection = openConnection();

// Le route conservano questo riferimento per tutta la vita del processo. Il
// proxy permette di sostituire la connessione dopo un restore. INVARIANTE:
// non conservare mai Statement o Transaction creati da db.prepare/db.transaction
// a livello di modulo; vanno creati dentro la funzione che li usa, altrimenti
// restano legati alla vecchia connessione chiusa.
const db = new Proxy({}, {
  get(_target, property) {
    const value = connection[property];
    return typeof value === "function" ? value.bind(connection) : value;
  },
});

function configureDurability() {
  const journalMode = db.pragma("journal_mode = WAL", { simple: true });
  if (String(journalMode).toLowerCase() !== "wal") {
    throw new Error(`Impossibile attivare SQLite WAL (modalita': ${journalMode})`);
  }
  // FULL sincronizza anche il WAL a ogni commit: per una cassa privilegiamo
  // la durabilita' in caso di perdita di alimentazione rispetto al throughput.
  db.pragma("synchronous = FULL");
  db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
}

function databaseBusyError(message) {
  const err = new Error(message);
  err.status = 409;
  err.publicMessage = message;
  return err;
}

function checkpointWal(database = connection) {
  if (!database?.open) return;
  const journalMode = database.pragma("journal_mode", { simple: true });
  if (String(journalMode).toLowerCase() !== "wal") return;
  const result = database.pragma("wal_checkpoint(TRUNCATE)")[0];
  if (!result || result.busy !== 0) {
    throw databaseBusyError(
      "Checkpoint WAL occupato: chiudi altri programmi che stanno leggendo il database"
    );
  }
}

function closeDatabase() {
  if (!connection?.open) return;
  checkpointWal(connection);
  connection.close();
  const remainingSidecars = DB_SIDECAR_PATHS.filter(sidecarPath => fs.existsSync(sidecarPath));
  if (remainingSidecars.length > 0) {
    throw databaseBusyError(
      "SQLite e' ancora aperto in un altro programma: impossibile chiudere in sicurezza i file WAL"
    );
  }
  fsyncDirectory(path.dirname(DB_PATH));
}

const CANONICAL_TABLES = [
  "products",
  "cash_sessions",
  "product_option_groups",
  "product_option_values",
  "sales",
  "app_state",
  "sale_items",
  "suspended_carts",
  "suspended_cart_items",
  "cash_movements",
];

const DROP_TABLE_ORDER = [
  "suspended_cart_items",
  "suspended_carts",
  "cash_movements",
  "sale_items",
  "sales",
  "product_option_values",
  "product_option_groups",
  "cash_sessions",
  "products",
  "app_state",
];

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Identificatore SQLite non valido: ${identifier}`);
  }
  return `"${identifier}"`;
}

function tableExistsIn(database, table) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
  `).get(table));
}

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
}

function canonicalTableSql(canonicalDb, table, replacement) {
  const row = canonicalDb.prepare(`
    SELECT sql FROM sqlite_master WHERE type='table' AND name=?
  `).get(table);
  if (!row?.sql) throw new Error(`Schema canonico mancante per ${table}`);

  const createPrefix = row.sql.match(
    /^CREATE TABLE(?: IF NOT EXISTS)?\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)/i
  );
  if (!createPrefix) throw new Error(`Definizione canonica non riconosciuta per ${table}`);
  return row.sql.replace(createPrefix[0], `CREATE TABLE ${quoteIdentifier(replacement)}`);
}

function copyCommonColumns(canonicalDb, table, destination) {
  if (!tableExistsIn(db, table)) return;

  const existing = new Set(tableColumns(db, table).map(column => column.name));
  const common = tableColumns(canonicalDb, table)
    .map(column => column.name)
    .filter(name => existing.has(name));
  if (common.length === 0) {
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count;
    if (count > 0) throw new Error(`Nessuna colonna compatibile nella tabella ${table}`);
    return;
  }

  const columns = common.map(quoteIdentifier).join(", ");
  db.exec(`
    INSERT INTO ${quoteIdentifier(destination)} (${columns})
    SELECT ${columns} FROM ${quoteIdentifier(table)}
  `);
}

function readLegacySequences() {
  if (!tableExistsIn(db, "sqlite_sequence")) return new Map();
  const names = new Set(CANONICAL_TABLES);
  return new Map(
    db.prepare("SELECT name, seq FROM sqlite_sequence").all()
      .filter(row => names.has(row.name))
      .map(row => [row.name, row.seq])
  );
}

function restoreLegacySequences(sequences) {
  const update = db.prepare(`
    UPDATE sqlite_sequence
    SET seq = CASE WHEN seq < ? THEN ? ELSE seq END
    WHERE name = ?
  `);
  const insert = db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)");
  for (const [table, sequence] of sequences) {
    const result = update.run(sequence, sequence, table);
    if (result.changes === 0) insert.run(table, sequence);
  }
}

// SQLite non consente di aggiungere CHECK e FOREIGN KEY a una tabella con
// ALTER TABLE. Per i DB precedenti alla versione corrente ricreiamo tutte le tabelle
// applicative dalla definizione canonica di schema.sql, copiamo i dati e
// sostituiamo gli originali in un'unica transazione.
function migrateLegacySchema(schema, previousVersion) {
  const canonicalDb = new Database(":memory:");

  try {
    canonicalDb.exec(schema);
    db.pragma("foreign_keys = OFF");
    if (db.pragma("foreign_keys", { simple: true }) !== 0) {
      throw new Error("Impossibile acquisire il lock di migrazione SQLite");
    }

    const migrate = db.transaction(() => {
      const legacySequences = readLegacySequences();
      for (const table of CANONICAL_TABLES) {
        const replacement = `__eventorder_migrate_${table}`;
        if (tableExistsIn(db, replacement)) {
          throw new Error(`Tabella temporanea inattesa: ${replacement}`);
        }
        db.exec(canonicalTableSql(canonicalDb, table, replacement));
        copyCommonColumns(canonicalDb, table, replacement);
      }

      // I database precedenti conservavano nome e categoria solo nei prodotti.
      db.exec(`
        UPDATE __eventorder_migrate_sale_items
        SET base_unit_price_cents = unit_price_cents
        WHERE base_unit_price_cents = 0 AND unit_price_cents > 0;

        UPDATE __eventorder_migrate_sale_items
        SET product_category = COALESCE(
          (SELECT category FROM __eventorder_migrate_products
           WHERE id = __eventorder_migrate_sale_items.product_id),
          'Generale'
        )
        WHERE product_name = '';

        UPDATE __eventorder_migrate_sale_items
        SET product_name = COALESCE(
          (SELECT name FROM __eventorder_migrate_products
           WHERE id = __eventorder_migrate_sale_items.product_id),
          ''
        )
        WHERE product_name = '';
      `);

      if (previousVersion < 3) {
        // Le sole vendite legacy ancora stornabili appartengono al turno aperto.
        db.exec(`
          UPDATE __eventorder_migrate_sale_items
          SET stock_decremented_qty = qty
          WHERE stock_decremented_qty = 0
            AND product_id IN (
              SELECT id FROM __eventorder_migrate_products WHERE stock IS NOT NULL
            )
            AND sale_id IN (
              SELECT s.id
              FROM __eventorder_migrate_sales s
              JOIN __eventorder_migrate_cash_sessions cs ON cs.id = s.session_id
              WHERE s.voided = 0 AND cs.closed_at IS NULL
            )
        `);
      }

      if (previousVersion < 6) {
        // Nel vecchio flusso una vendita rimaneva valida solo dopo il successo
        // della stampa. Le vendite storiche valide sono quindi considerate
        // stampate; gli annulli automatici per errore stampante restano failed.
        db.exec(`
          UPDATE __eventorder_migrate_sales
          SET print_status = CASE
                WHEN voided = 1 AND void_reason = 'Stampa non riuscita' THEN 'failed'
                ELSE 'printed'
              END,
              print_attempts = 1,
              last_print_error = CASE
                WHEN voided = 1 AND void_reason = 'Stampa non riuscita' THEN void_reason
                ELSE NULL
              END,
              last_print_attempt_at = created_at,
              last_printed_at = CASE
                WHEN voided = 1 AND void_reason = 'Stampa non riuscita' THEN NULL
                ELSE created_at
              END
        `);
      }

      for (const table of DROP_TABLE_ORDER) {
        if (tableExistsIn(db, table)) {
          db.exec(`DROP TABLE ${quoteIdentifier(table)}`);
        }
      }
      for (const table of CANONICAL_TABLES) {
        db.exec(`
          ALTER TABLE ${quoteIdentifier(`__eventorder_migrate_${table}`)}
          RENAME TO ${quoteIdentifier(table)}
        `);
      }
      restoreLegacySequences(legacySequences);

      // Ricrea anche indici e vincoli di unicita' prima del commit: eventuali
      // duplicati legacy fanno fallire e annullare l'intera migrazione.
      db.exec(schema);
      const foreignKeyErrors = db.pragma("foreign_key_check");
      if (foreignKeyErrors.length > 0) {
        const first = foreignKeyErrors[0];
        throw new Error(`Relazione non valida in ${first.table}, riga ${first.rowid}`);
      }
      db.pragma(`user_version = ${DB_SCHEMA_VERSION}`);
    });

    migrate();
  } catch (err) {
    throw new Error(`Migrazione schema v${DB_SCHEMA_VERSION} non riuscita: ${err.message}`, { cause: err });
  } finally {
    db.pragma("foreign_keys = ON");
    if (db.pragma("foreign_keys", { simple: true }) !== 1) {
      canonicalDb.close();
      throw new Error("Impossibile riattivare le foreign key SQLite");
    }
    canonicalDb.close();
  }
}

function initDb() {
  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  const previousVersion = db.pragma("user_version", { simple: true });
  if (previousVersion > DB_SCHEMA_VERSION) {
    throw new Error(`Database creato da una versione piu' recente (${previousVersion})`);
  }
  configureDurability();

  const hasLegacyTables = CANONICAL_TABLES.some(table => tableExistsIn(db, table));
  if (hasLegacyTables && previousVersion < DB_SCHEMA_VERSION) {
    migrateLegacySchema(schema, previousVersion);
  } else {
    db.exec(schema);
    if (previousVersion < DB_SCHEMA_VERSION) {
      db.pragma(`user_version = ${DB_SCHEMA_VERSION}`);
    }
  }

  // seed demo generico se non ci sono prodotti (disattivabile con POS_SEED_DEMO=0)
  const count = db.prepare("SELECT COUNT(*) AS c FROM products").get().c;
  if (count === 0 && config.SEED_DEMO) {
    const ins = db.prepare(`
      INSERT INTO products (name, price_cents, category, sort_order)
      VALUES (@name, @price_cents, @category, @sort_order)
    `);
    const seed = [
      { name: "Prodotto A", price_cents: 500, category: "Generale", sort_order: 10 },
      { name: "Prodotto B", price_cents: 600, category: "Generale", sort_order: 20 },
      { name: "Prodotto C", price_cents: 350, category: "Generale", sort_order: 30 },
      { name: "Prodotto D", price_cents: 200, category: "Generale", sort_order: 40 },
    ];
    const tx = db.transaction(() => seed.forEach(r => ins.run(r)));
    tx();
  }

  const maxSaleNumber = db.prepare(`
    SELECT COALESCE(MAX(sale_number), 0) AS value
    FROM sales
  `).get().value;

  db.prepare(`
    INSERT INTO app_state (key, int_value)
    VALUES ('sale_number', ?)
    ON CONFLICT(key) DO UPDATE SET int_value = excluded.int_value
    WHERE app_state.int_value < excluded.int_value
  `).run(maxSaleNumber);
}

function getNextSaleNumber() {
  const row = db.prepare(`
    UPDATE app_state
    SET int_value = int_value + 1
    WHERE key = 'sale_number'
    RETURNING int_value
  `).get();

  if (!row) {
    throw new Error("Contatore sale_number non inizializzato");
  }

  return Number(row.int_value);
}

// Turno di cassa attualmente aperto (o undefined)
function getOpenSession() {
  return db.prepare(`
    SELECT * FROM cash_sessions
    WHERE closed_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `).get();
}

const REQUIRED_RESTORE_SCHEMA = {
  products: ["id", "name", "price_cents", "category"],
  cash_sessions: ["id", "opened_at", "closed_at", "opening_float_cents"],
  sales: ["id", "sale_number", "total_cents", "created_at"],
  sale_items: ["id", "sale_id", "product_id", "qty", "unit_price_cents", "line_total_cents"],
  app_state: ["key", "int_value"],
};

function restoreError(message) {
  const err = new Error(message);
  err.status = 400;
  err.publicMessage = message;
  return err;
}

// Apre il file separatamente e in sola lettura: nessun contenuto del backup
// viene eseguito o copiato prima che integrita' e identita' siano verificate.
function validateRestoreCandidate(candidatePath) {
  let candidate;
  try {
    candidate = new Database(candidatePath, { readonly: true, fileMustExist: true });

    const integrity = candidate.pragma("integrity_check");
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw restoreError("Il file SQLite non supera il controllo di integrita'");
    }

    const foreignKeyErrors = candidate.pragma("foreign_key_check");
    if (foreignKeyErrors.length > 0) {
      throw restoreError("Il backup contiene relazioni non valide");
    }

    // EventOrder non usa trigger o view. Rifiutarli evita che un file SQLite
    // estraneo possa eseguire effetti inattesi durante le migrazioni.
    const executableSchema = candidate.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE type IN ('trigger', 'view')
      LIMIT 1
    `).get();
    if (executableSchema) {
      throw restoreError("Il file non e' un backup EventOrder supportato");
    }

    for (const [table, requiredColumns] of Object.entries(REQUIRED_RESTORE_SCHEMA)) {
      const exists = candidate.prepare(`
        SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
      `).get(table);
      if (!exists) throw restoreError(`Backup non valido: tabella ${table} mancante`);

      const columns = new Set(candidate.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
      if (requiredColumns.some(column => !columns.has(column))) {
        throw restoreError(`Backup non valido: struttura ${table} non compatibile`);
      }
    }

    const userVersion = candidate.pragma("user_version", { simple: true });
    if (userVersion > DB_SCHEMA_VERSION) {
      throw restoreError("Il backup proviene da una versione piu' recente di EventOrder");
    }

    return {
      products: candidate.prepare("SELECT COUNT(*) AS count FROM products").get().count,
      sales: candidate.prepare("SELECT COUNT(*) AS count FROM sales").get().count,
      sessions: candidate.prepare("SELECT COUNT(*) AS count FROM cash_sessions").get().count,
      userVersion,
    };
  } catch (err) {
    if (err.status === 400) throw err;
    throw restoreError("Il file selezionato non e' un database SQLite EventOrder valido");
  } finally {
    candidate?.close();
  }
}

// Il marker viene sincronizzato prima del rename atomico. Un errore in-process
// o un crash provoca il recupero del backup pre-restore, mai un DB vuoto.
function restoreDatabaseFromFile(candidatePath, safetyBackupPath) {
  try {
    // Il lock applicativo blocca nuove route; il checkpoint rileva anche
    // eventuali lettori esterni e impedisce la sostituzione finche' il WAL non
    // e' interamente consolidato nel file principale.
    closeDatabase();
    writeRestoreMarker(safetyBackupPath);
    fs.renameSync(candidatePath, DB_PATH);
    fsyncDirectory(path.dirname(DB_PATH));

    connection = openConnection();
    initDb();

    const foreignKeyErrors = db.pragma("foreign_key_check");
    if (foreignKeyErrors.length > 0) {
      throw new Error("Il database ripristinato non supera il controllo delle relazioni");
    }

    fs.rmSync(RESTORE_MARKER_PATH, { force: true });
    fsyncDirectory(path.dirname(DB_PATH));
    return;
  } catch (err) {
    try { if (connection?.open) connection.close(); } catch {}
    recoverFromRestoreMarker();
    connection = openConnection();
    initDb();
    throw err;
  }
}

module.exports = {
  db,
  initDb,
  getNextSaleNumber,
  getOpenSession,
  validateRestoreCandidate,
  restoreDatabaseFromFile,
  closeDatabase,
  RESTORE_MARKER_PATH,
  DB_PATH,
  DB_BUSY_TIMEOUT_MS,
};
