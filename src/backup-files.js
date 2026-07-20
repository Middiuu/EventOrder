const fs = require("node:fs");
const path = require("node:path");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function backupKind(filename, slug) {
  const escapedSlug = escapeRegExp(slug);
  const stamp = "\\d{8}-\\d{6}(?:-\\d+)?";
  if (new RegExp(`^${escapedSlug}-(?:backup|pre-restore)-${stamp}\\.sqlite$`).test(filename)) {
    return "operational";
  }
  if (new RegExp(
    `^${escapedSlug}-pre-migration-v\\d+-to-v\\d+-${stamp}\\.sqlite$`
  ).test(filename)) {
    return "pre-migration";
  }
  return null;
}

function isDownloadableBackupName(filename, slug) {
  return Boolean(backupKind(filename, slug));
}

function filesToRemove(files, keep, protectedNames) {
  if (!keep) return [];
  const protectedCount = files.filter(({ file }) => protectedNames.has(file)).length;
  let remainingSlots = Math.max(0, keep - protectedCount);
  const removed = [];
  for (const entry of files) {
    if (protectedNames.has(entry.file)) continue;
    if (remainingSlots > 0) {
      remainingSlots -= 1;
    } else {
      removed.push(entry);
    }
  }
  return removed;
}

function pruneBackupFiles(backupsDir, {
  slug,
  keepOperational,
  keepPreMigration,
  protectedNames = [],
}) {
  const protectedSet = new Set(protectedNames);
  const groups = { operational: [], "pre-migration": [] };

  for (const file of fs.readdirSync(backupsDir)) {
    const kind = backupKind(file, slug);
    if (!kind) continue;
    const filePath = path.join(backupsDir, file);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    groups[kind].push({ file, modifiedAt: stat.mtimeMs });
  }

  for (const files of Object.values(groups)) {
    files.sort((left, right) => right.modifiedAt - left.modifiedAt);
  }
  const removed = [
    ...filesToRemove(groups.operational, keepOperational, protectedSet),
    ...filesToRemove(groups["pre-migration"], keepPreMigration, protectedSet),
  ];
  for (const { file } of removed) {
    fs.rmSync(path.join(backupsDir, file), { force: true });
  }
  return removed.map(({ file }) => file);
}

module.exports = {
  backupKind,
  isDownloadableBackupName,
  pruneBackupFiles,
};
