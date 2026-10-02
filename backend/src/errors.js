export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const fail = (status, code, message, details) => { throw new ApiError(status, code, message, details); };
export const unavailable = (service) => fail(503, 'SERVICE_NOT_CONFIGURED', `${service}は現在利用できません。`);

export function installErrorHandler(app) {
  app.setErrorHandler((error, request, reply) => {
    let status = error.status ?? 500;
    let code = error.code;
    let message = error.message;
    if (error.name === 'ZodError' || error.validation) {
      status = 400; code = 'VALIDATION_ERROR'; message = '入力内容をご確認ください。';
    } else if (['23505', '23503', '23514', '40001', '40P01'].includes(error.code)) {
      status = 409; code = 'STATE_CONFLICT'; message = '状態が変更されました。もう一度ご確認ください。';
    } else if (!(error instanceof ApiError)) {
      status = error.statusCode === 413 ? 413 : error.statusCode === 400 ? 400 : 500;
      code = status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 400 ? 'VALIDATION_ERROR' : 'SYS-001';
      message = status === 500 ? '処理を完了できませんでした。' : 'リクエストをご確認ください。';
    }
    // Do not log SQL, exception text, request bodies, tokens, images, or addresses.
    request.log[status >= 500 ? 'error' : 'info']({ requestId: request.id, errorCode: code, status }, 'request_failed');
    reply.code(status).send({ error: { code, message, request_id: request.id, ...(error.details ? { details: error.details } : {}) } });
  });
}
