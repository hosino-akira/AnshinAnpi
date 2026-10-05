export class MailFailure extends Error {
  constructor(code, { uncertain = false, retryable = false } = {}) {
    super(code);
    this.code = code;
    this.uncertain = uncertain;
    this.retryable = retryable;
  }
}
