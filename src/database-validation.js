const Database = require("better-sqlite3");

function normalizeSchemaSql(sql) {
  if (!sql) return null;

  return sql
    .replace(
      /^CREATE\s+(VIRTUAL\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)/i,
      (_match, virtual = "") => `CREATE ${virtual}TABLE <object>`
    )
    .replace(
      /^CREATE\s+(UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)/i,
      (_match, unique = "") => `CREATE ${unique}INDEX <object>`
    )
    .replace(/\s+/g, " ")
    .trim();
}

function schemaSnapshot(database) {
  return new Map(database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all().map(row => [
    `${row.type}:${row.name}`,
    { table: row.tbl_name, sql: normalizeSchemaSql(row.sql) },
  ]));
}

function schemaDifferences(actual, expected) {
  const differences = [];
  const keys = new Set([...actual.keys(), ...expected.keys()]);
  for (const key of [...keys].sort()) {
    const actualEntry = actual.get(key);
    const expectedEntry = expected.get(key);
    if (!actualEntry || !expectedEntry
      || actualEntry.table !== expectedEntry.table
      || actualEntry.sql !== expectedEntry.sql) {
      differences.push(key.slice(key.indexOf(":") + 1));
    }
  }
  return differences;
}

function checkResult(database, pragma, resultKey) {
  const result = database.pragma(pragma);
  if (result.length === 1 && result[0][resultKey] === "ok") return;
  const details = result
    .map(row => String(row[resultKey] ?? Object.values(row)[0] ?? "errore sconosciuto"))
    .join("; ");
  throw new Error(`${pragma} fallito: ${details}`);
}

function validateCanonicalDatabase(database, schema, expectedVersion, { fullIntegrity = false } = {}) {
  const version = database.pragma("user_version", { simple: true });
  if (version !== expectedVersion) {
    throw new Error(`user_version inattesa: v${version}, attesa v${expectedVersion}`);
  }

  const canonical = new Database(":memory:");
  try {
    canonical.exec(schema);
    const differences = schemaDifferences(schemaSnapshot(database), schemaSnapshot(canonical));
    if (differences.length > 0) {
      throw new Error(`schema SQLite non canonico: ${differences.join(", ")}`);
    }
  } finally {
    canonical.close();
  }

  if (fullIntegrity) {
    checkResult(database, "integrity_check", "integrity_check");
  } else {
    checkResult(database, "quick_check", "quick_check");
  }

  const foreignKeyErrors = database.pragma("foreign_key_check");
  if (foreignKeyErrors.length > 0) {
    const first = foreignKeyErrors[0];
    throw new Error(`foreign_key_check fallito: ${first.table}, riga ${first.rowid}`);
  }
}

module.exports = { validateCanonicalDatabase };
