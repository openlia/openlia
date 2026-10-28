/** Defense in depth: a forgotten API prop must not reach a real backend. */
export function installStoryNetworkGuard() {
  globalThis.fetch = new Proxy(globalThis.fetch, {
    apply(target, _receiver, args: Parameters<typeof fetch>) {
      const [input] = args;
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.href,
      );
      if (
        (url.protocol !== "data:" &&
          url.protocol !== "blob:" &&
          url.origin !== window.location.origin) ||
        /^\/(?:api|_server)\//.test(url.pathname)
      ) {
        document.documentElement.dataset.storybookBlockedRequest = url.pathname;
        return Promise.reject(
          new Error(
            `Storybook blocked a live request: ${url.pathname}. Supply an in-memory fixture API.`,
          ),
        );
      }
      return Reflect.apply(target, globalThis, args);
    },
  });
}
