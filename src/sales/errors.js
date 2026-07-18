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

function responseError(status, body) {
  const error = httpError(status, body.error);
  error.response = body;
  return error;
}

module.exports = { badRequest, conflictError, httpError, responseError };
