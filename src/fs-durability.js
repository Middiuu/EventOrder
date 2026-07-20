const fs = require("node:fs");

const UNSUPPORTED_DIRECTORY_FSYNC_ERRORS = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

function fsyncDirectory(dirPath, fileSystem = fs) {
  let fd;
  try {
    fd = fileSystem.openSync(dirPath, "r");
    fileSystem.fsyncSync(fd);
  } catch (err) {
    if (!UNSUPPORTED_DIRECTORY_FSYNC_ERRORS.has(err?.code)) throw err;
  } finally {
    if (fd !== undefined) fileSystem.closeSync(fd);
  }
}

module.exports = { fsyncDirectory };
