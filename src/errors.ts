// An error a person will read. The message says what happened and what to do
// next, in plain words, and never contains a raw error from a library.
export class UserFacingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UserFacingError";
    this.code = code;
  }
}
