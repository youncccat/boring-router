const FULFILLED_PROMISE = Promise.resolve();

export function then(handler: () => void): void {
  // tslint:disable-next-line:no-floating-promises
  FULFILLED_PROMISE.then(handler);
}