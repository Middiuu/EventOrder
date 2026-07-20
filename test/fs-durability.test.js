const test = require("node:test");
const assert = require("node:assert/strict");
const { fsyncDirectory } = require("../src/fs-durability");

test("fsyncDirectory ignora solo gli errori di filesystem non supportato", () => {
  for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP"]) {
    const closed = [];
    const fileSystem = {
      openSync: () => 42,
      fsyncSync: () => { throw Object.assign(new Error(code), { code }); },
      closeSync: fd => closed.push(fd),
    };

    assert.doesNotThrow(() => fsyncDirectory("/tmp/test", fileSystem));
    assert.deepEqual(closed, [42]);
  }
});

test("fsyncDirectory propaga gli errori I/O reali e chiude il descriptor", () => {
  const closed = [];
  const ioError = Object.assign(new Error("disco non disponibile"), { code: "EIO" });
  const fileSystem = {
    openSync: () => 7,
    fsyncSync: () => { throw ioError; },
    closeSync: fd => closed.push(fd),
  };

  assert.throws(() => fsyncDirectory("/tmp/test", fileSystem), error => error === ioError);
  assert.deepEqual(closed, [7]);
});

test("fsyncDirectory propaga gli errori di apertura senza chiudere descriptor inesistenti", () => {
  let closed = false;
  const permissionError = Object.assign(new Error("accesso negato"), { code: "EACCES" });
  const fileSystem = {
    openSync: () => { throw permissionError; },
    fsyncSync: () => {},
    closeSync: () => { closed = true; },
  };

  assert.throws(() => fsyncDirectory("/tmp/test", fileSystem), error => error === permissionError);
  assert.equal(closed, false);
});
