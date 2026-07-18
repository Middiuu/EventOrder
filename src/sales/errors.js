function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  return error;
}

function badRequest(message) {
  return httpError(400, message);
}

function conflictError(message) {
  return httpError(409, message);
}

module.exports = { badRequest, conflictError, httpError };
