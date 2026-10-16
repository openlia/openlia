import { AsyncLocalStorage } from "node:async_hooks";

const nonceStorage = new AsyncLocalStorage<string>();

export function withCspNonce<T>(nonce: string, callback: () => T): T {
  return nonceStorage.run(nonce, callback);
}

export function currentCspNonce(): string | undefined {
  return nonceStorage.getStore();
}
