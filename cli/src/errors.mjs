export class QuayError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
    this.name = "QuayError";
  }
}

export function usage(message) {
  return new QuayError(message, 1);
}

export function chainError(message) {
  return new QuayError(message, 2);
}

export function refused(message) {
  return new QuayError(message, 3);
}
