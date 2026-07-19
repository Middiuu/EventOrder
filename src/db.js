const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { config } = require("./config");

const DB_PATH = process.env.POS_DB_PATH
  ? path.resolve(process.env.POS_DB_PATH)
  : path.join(__dirname, "..", "pos.sqlite");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");
const DB_SCHEMA_VERSION = 11;
const DB_BUSY_TIMEOUT_MS = 5000;
const RESTORE_MARKER_PATH = `${DB_PATH}.restore-state.json`;
const MIGRATION_MARKER_PATH = `${DB_PATH}.migration-state.json`;
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

function writeMigrationMarker(safetyBackupPath, fromVersion, toVersion) {
  const verified = verifiedSafetyBackup(safetyBackupPath);
  const tempPath = `${MIGRATION_MARKER_PATH}.${process.pid}.tmp`;
  const fd = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({
      safetyBackupPath: verified,
      fromVersion,
      toVersion,
      createdAt: new Date().toISOString(),
    }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, MIGRATION_MARKER_PATH);
  fsyncDirectory(path.dirname(DB_PATH));
}

function recoverFromMigrationMarker() {
  if (!fs.existsSync(MIGRATION_MARKER_PATH)) return false;

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(MIGRATION_MARKER_PATH, "utf8"));
  } catch {
    throw new Error(
      `Migrazione interrotta: marker non leggibile (${MIGRATION_MARKER_PATH}). Intervento manuale richiesto.`
    );
  }
  if (!Number.isSafeInteger(marker.fromVersion) || !Number.isSafeInteger(marker.toVersion)) {
    throw new Error("Migrazione interrotta: versioni del marker non valide. Intervento manuale richiesto.");
  }
  const safetyBackupPath = verifiedSafetyBackup(marker.safetyBackupPath);
  const recoveryPath = `${DB_PATH}.migration-recovery-${process.pid}-${Date.now()}`;
  fs.copyFileSync(safetyBackupPath, recoveryPath, fs.constants.COPYFILE_EXCL);
  const fd = fs.openSync(recoveryPath, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }

  removeDatabaseSidecars();
  fs.renameSync(recoveryPath, DB_PATH);
  fs.rmSync(MIGRATION_MARKER_PATH, { force: true });
  fsyncDirectory(path.dirname(DB_PATH));
  console.warn(
    `Rilevata una migrazione v${marker.fromVersion}->v${marker.toVersion} interrotta: ` +
    "recuperato automaticamente il backup pre-migrazione."
  );
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

if (fs.existsSync(RESTORE_MARKER_PATH) && fs.existsSync(MIGRATION_MARKER_PATH)) {
  throw new Error("Stato ambiguo: presenti marker di restore e migrazione. Intervento manuale richiesto.");
}
recoverFromRestoreMarker();
recoverFromMigrationMarker();
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
  "operation_requests",
  "auth_sessions",
  "login_attempts",
  "audit_events",
];

const DROP_TABLE_ORDER = [
  "audit_events",
  "login_attempts",
  "auth_sessions",
  "operation_requests",
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

const DERIVED_SEARCH_TABLES = [
  "sale_items_search",
  "sale_items_search_config",
  "sale_items_search_data",
  "sale_items_search_docsize",
  "sale_items_search_idx",
];

// Ogni versione legacy supportata deve comparire una sola volta in una
// definizione diretta verso il target corrente. A ogni bump il registro va
// aggiornato esplicitamente, separando in piu' voci le versioni che richiedono
// mappature vecchio->nuovo differenti.
const CANONICAL_REBUILD_MIGRATION = Object.freeze({
  targetVersion: 11,
  sourceVersions: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  columnMappings: Object.freeze({}),
});
const SCHEMA_MIGRATIONS = Object.freeze([CANONICAL_REBUILD_MIGRATION]);
const SUPPORTED_MIGRATION_SOURCES = Object.freeze(
  SCHEMA_MIGRATIONS.flatMap(migration => migration.sourceVersions)
);

function validateMigrationRegistry() {
  const targets = SCHEMA_MIGRATIONS.map(migration => migration.targetVersion);
  if (targets.some(target => target !== DB_SCHEMA_VERSION)) {
    throw new Error(`Registro migrazioni non allineato al target corrente v${DB_SCHEMA_VERSION}`);
  }
  const sortedSources = [...SUPPORTED_MIGRATION_SOURCES].sort((a, b) => a - b);
  const expectedSources = Array.from({ length: DB_SCHEMA_VERSION }, (_, version) => version);
  if (new Set(sortedSources).size !== sortedSources.length
    || sortedSources.some((version, index) => version !== expectedSources[index])) {
    throw new Error(`Registro migrazioni incompleto o ambiguo per il target v${DB_SCHEMA_VERSION}`);
  }
}
validateMigrationRegistry();

function migrationForSource(sourceVersion) {
  const migration = SCHEMA_MIGRATIONS.find(candidate => (
    candidate.targetVersion > sourceVersion && candidate.sourceVersions.includes(sourceVersion)
  ));
  if (!migration) {
    throw new Error(`Nessuna migrazione registrata per lo schema v${sourceVersion}`);
  }
  return migration;
}

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

function copyMappedColumns(database, canonicalDb, table, destination, columnMappings = {}) {
  if (!tableExistsIn(database, table)) return;

  const sourceColumns = tableColumns(database, table).map(column => column.name);
  const canonicalColumns = new Set(tableColumns(canonicalDb, table).map(column => column.name));
  const destinations = new Set();
  const copied = [];

  for (const source of sourceColumns) {
    const destinationColumn = columnMappings[source]
      || (canonicalColumns.has(source) ? source : null);
    if (!destinationColumn) {
      const populated = database.prepare(`
        SELECT 1 FROM ${quoteIdentifier(table)}
        WHERE ${quoteIdentifier(source)} IS NOT NULL
        LIMIT 1
      `).get();
      if (populated) {
        throw new Error(`Colonna legacy popolata senza mappatura: ${table}.${source}`);
      }
      continue;
    }
    if (!canonicalColumns.has(destinationColumn)) {
      throw new Error(`Mappatura verso colonna canonica inesistente: ${table}.${source}->${destinationColumn}`);
    }
    if (destinations.has(destinationColumn)) {
      throw new Error(`Mappatura legacy ambigua verso ${table}.${destinationColumn}`);
    }
    destinations.add(destinationColumn);
    copied.push({ source, destination: destinationColumn });
  }

  if (copied.length === 0) {
    const count = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count;
    if (count > 0) throw new Error(`Nessuna colonna compatibile nella tabella ${table}`);
    return;
  }

  const destinationColumns = copied.map(column => quoteIdentifier(column.destination)).join(", ");
  const sourceExpressions = copied.map(column => quoteIdentifier(column.source)).join(", ");
  database.exec(`
    INSERT INTO ${quoteIdentifier(destination)} (${destinationColumns})
    SELECT ${sourceExpressions} FROM ${quoteIdentifier(table)}
  `);
}

function readLegacySequences(database) {
  if (!tableExistsIn(database, "sqlite_sequence")) return new Map();
  const names = new Set(CANONICAL_TABLES);
  return new Map(
    database.prepare("SELECT name, seq FROM sqlite_sequence").all()
      .filter(row => names.has(row.name))
      .map(row => [row.name, row.seq])
  );
}

function restoreLegacySequences(database, sequences) {
  const update = database.prepare(`
    UPDATE sqlite_sequence
    SET seq = CASE WHEN seq < ? THEN ? ELSE seq END
    WHERE name = ?
  `);
  const insert = database.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)");
  for (const [table, sequence] of sequences) {
    const result = update.run(sequence, sequence, table);
    if (result.changes === 0) insert.run(table, sequence);
  }
}

// SQLite non consente di aggiungere CHECK e FOREIGN KEY a una tabella con
// ALTER TABLE. Per i DB precedenti alla versione corrente ricreiamo tutte le tabelle
// applicative dalla definizione canonica di schema.sql, copiamo i dati e
// sostituiamo gli originali in un'unica transazione.
function migrateLegacySchema(database, schema, previousVersion) {
  const migration = previousVersion === DB_SCHEMA_VERSION
    ? CANONICAL_REBUILD_MIGRATION
    : migrationForSource(previousVersion);
  const canonicalDb = new Database(":memory:");
  let migrationError = null;
  let cleanupError = null;

  try {
    canonicalDb.exec(schema);
    database.pragma("foreign_keys = OFF");
    if (database.pragma("foreign_keys", { simple: true }) !== 0) {
      throw new Error("Impossibile acquisire il lock di migrazione SQLite");
    }

    const migrate = database.transaction(() => {
      const legacySequences = readLegacySequences(database);
      for (const table of CANONICAL_TABLES) {
        const replacement = `__eventorder_migrate_${table}`;
        if (tableExistsIn(database, replacement)) {
          throw new Error(`Tabella temporanea inattesa: ${replacement}`);
        }
        database.exec(canonicalTableSql(canonicalDb, table, replacement));
        copyMappedColumns(
          database,
          canonicalDb,
          table,
          replacement,
          migration.columnMappings[table] || {}
        );
      }

      // I database precedenti conservavano nome e categoria solo nei prodotti.
      database.exec(`
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
        database.exec(`
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
        database.exec(`
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

      // L'indice FTS e' derivato: non copiamo strutture o segmenti ricevuti da
      // database legacy/restore, ma li rigeneriamo dallo snapshot canonico.
      for (const table of DERIVED_SEARCH_TABLES) {
        if (tableExistsIn(database, table)) {
          database.exec(`DROP TABLE ${quoteIdentifier(table)}`);
        }
      }

      for (const table of DROP_TABLE_ORDER) {
        if (tableExistsIn(database, table)) {
          database.exec(`DROP TABLE ${quoteIdentifier(table)}`);
        }
      }
      for (const table of CANONICAL_TABLES) {
        database.exec(`
          ALTER TABLE ${quoteIdentifier(`__eventorder_migrate_${table}`)}
          RENAME TO ${quoteIdentifier(table)}
        `);
      }
      restoreLegacySequences(database, legacySequences);

      // Ricrea anche indici e vincoli di unicita' prima del commit: eventuali
      // duplicati legacy fanno fallire e annullare l'intera migrazione.
      database.exec(schema);
      database.exec(`
        INSERT INTO sale_items_search(sale_items_search) VALUES('rebuild');
      `);
      const foreignKeyErrors = database.pragma("foreign_key_check");
      if (foreignKeyErrors.length > 0) {
        const first = foreignKeyErrors[0];
        throw new Error(`Relazione non valida in ${first.table}, riga ${first.rowid}`);
      }
      database.pragma(`user_version = ${migration.targetVersion}`);
    });

    migrate();
  } catch (err) {
    migrationError = new Error(
      `Migrazione schema v${previousVersion}->v${migration.targetVersion} non riuscita: ${err.message}`,
      { cause: err }
    );
  } finally {
    database.pragma("foreign_keys = ON");
    if (database.pragma("foreign_keys", { simple: true }) !== 1) {
      cleanupError = new Error("Impossibile riattivare le foreign key SQLite");
    }
    canonicalDb.close();
  }
  if (migrationError) {
    if (cleanupError) migrationError.cleanupError = cleanupError;
    throw migrationError;
  }
  if (cleanupError) throw cleanupError;
}

function preMigrationBackupStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function createPreMigrationBackup(database, fromVersion, toVersion) {
  const backupsDir = path.resolve(path.dirname(DB_PATH), "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const base = `${config.SLUG}-pre-migration-v${fromVersion}-to-v${toVersion}-${preMigrationBackupStamp()}`;
  let backupName = `${base}.sqlite`;
  let suffix = 2;
  while (fs.existsSync(path.join(backupsDir, backupName))) {
    backupName = `${base}-${suffix++}.sqlite`;
  }
  const backupPath = path.join(backupsDir, backupName);
  const tempPath = `${backupPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let verification;

  try {
    database.prepare("VACUUM INTO ?").run(tempPath);
    fs.chmodSync(tempPath, 0o600);
    verification = new Database(tempPath, { readonly: true, fileMustExist: true });
    const integrity = verification.pragma("integrity_check");
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw new Error("Il backup pre-migrazione non supera integrity_check");
    }
    const backupVersion = verification.pragma("user_version", { simple: true });
    if (backupVersion !== fromVersion) {
      throw new Error(`Versione inattesa nel backup pre-migrazione: v${backupVersion}`);
    }
    verification.close();
    verification = null;

    const fd = fs.openSync(tempPath, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tempPath, backupPath);
    fsyncDirectory(backupsDir);
    return backupPath;
  } finally {
    try { verification?.close(); } catch {}
    fs.rmSync(tempPath, { force: true });
  }
}

function completeMigrationMarker() {
  fs.rmSync(MIGRATION_MARKER_PATH, { force: true });
  fsyncDirectory(path.dirname(DB_PATH));
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
    const migration = migrationForSource(previousVersion);
    const safetyBackupPath = createPreMigrationBackup(
      db,
      previousVersion,
      migration.targetVersion
    );
    writeMigrationMarker(safetyBackupPath, previousVersion, migration.targetVersion);
    migrateLegacySchema(db, schema, previousVersion);
    const quickCheck = db.pragma("quick_check");
    if (quickCheck.length !== 1 || quickCheck[0].quick_check !== "ok") {
      throw new Error("Il database migrato non supera quick_check");
    }
    completeMigrationMarker();
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

  db.prepare(`
    INSERT OR IGNORE INTO app_state (key, int_value)
    VALUES ('database_instance_id', ?)
  `).run(newDatabaseInstanceId());
}

function newDatabaseInstanceId() {
  // 48 bit casuali: rappresentabili esattamente come Number e come INTEGER
  // SQLite, ma abbastanza ampi da non confondere draft di istanze diverse.
  return crypto.randomBytes(6).readUIntBE(0, 6);
}

function getDatabaseInstanceId() {
  return db.prepare(`
    SELECT int_value FROM app_state WHERE key = 'database_instance_id'
  `).get()?.int_value;
}

function rotateDatabaseInstanceId() {
  const value = newDatabaseInstanceId();
  db.prepare(`
    INSERT INTO app_state (key, int_value) VALUES ('database_instance_id', ?)
    ON CONFLICT(key) DO UPDATE SET int_value = excluded.int_value
  `).run(value);
  return value;
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

function canonicalizeRestoreCandidate(candidatePath, sourceVersion) {
  const validationPath = `${candidatePath}.canonical-${process.pid}-${Date.now()}`;
  let validationDb;
  try {
    fs.copyFileSync(candidatePath, validationPath, fs.constants.COPYFILE_EXCL);
    validationDb = new Database(validationPath, { fileMustExist: true });
    validationDb.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    validationDb.pragma("foreign_keys = ON");

    // Ricostruire una copia isolata applica tutti i CHECK/FK/UNIQUE canonici
    // anche se il file dichiara gia' la versione corrente ma ne imita solo una
    // parte dello schema. Il file ricevuto non diventa mai il DB attivo.
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    migrateLegacySchema(validationDb, schema, sourceVersion);

    const integrity = validationDb.pragma("integrity_check");
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw new Error("controllo di integrita' fallito dopo la canonicalizzazione");
    }
    if (validationDb.pragma("foreign_key_check").length > 0) {
      throw new Error("relazioni non valide dopo la canonicalizzazione");
    }
    validationDb.pragma("journal_mode = DELETE");
    validationDb.close();
    validationDb = null;

    const fd = fs.openSync(validationPath, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(validationPath, candidatePath);
    fsyncDirectory(path.dirname(candidatePath));
  } finally {
    try { validationDb?.close(); } catch {}
    fs.rmSync(validationPath, { force: true });
    fs.rmSync(`${validationPath}-wal`, { force: true });
    fs.rmSync(`${validationPath}-shm`, { force: true });
  }
}

// Apre prima il file in sola lettura per verificarne identita' e integrita',
// poi sostituisce l'upload con una copia ricostruita nello schema canonico.
function validateRestoreCandidate(candidatePath) {
  let candidate;
  let inspected;
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

    const allowedTables = [...CANONICAL_TABLES, ...DERIVED_SEARCH_TABLES];
    const unexpectedTable = candidate.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT IN (${allowedTables.map(() => "?").join(",")})
      LIMIT 1
    `).get(...allowedTables);
    if (unexpectedTable) {
      throw restoreError(`Backup non valido: tabella inattesa ${unexpectedTable.name}`);
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

    inspected = {
      products: candidate.prepare("SELECT COUNT(*) AS count FROM products").get().count,
      sales: candidate.prepare("SELECT COUNT(*) AS count FROM sales").get().count,
      sessions: candidate.prepare("SELECT COUNT(*) AS count FROM cash_sessions").get().count,
      sourceUserVersion: userVersion,
      userVersion: DB_SCHEMA_VERSION,
    };
  } catch (err) {
    if (err.status === 400) throw err;
    throw restoreError("Il file selezionato non e' un database SQLite EventOrder valido");
  } finally {
    candidate?.close();
  }

  try {
    canonicalizeRestoreCandidate(candidatePath, inspected.sourceUserVersion);
    return inspected;
  } catch {
    throw restoreError("Il backup contiene schema o dati non compatibili con EventOrder");
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
    rotateDatabaseInstanceId();

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
  getDatabaseInstanceId,
  validateRestoreCandidate,
  restoreDatabaseFromFile,
  closeDatabase,
  RESTORE_MARKER_PATH,
  MIGRATION_MARKER_PATH,
  DB_PATH,
  DB_BUSY_TIMEOUT_MS,
  DB_SCHEMA_VERSION,
  SUPPORTED_MIGRATION_SOURCES,
};
