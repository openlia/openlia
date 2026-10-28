import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

const root = realpathSync(resolve(import.meta.dir, "../.storybook-static"));
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.STORYBOOK_PORT ?? "6007"),
  fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Read only", { status: 405 });
    try {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const path = resolve(
        root,
        `.${pathname === "/" ? "/index.html" : pathname}`,
      );
      if (!path.startsWith(`${root}${sep}`) || !existsSync(path))
        return new Response("Not found", { status: 404 });
      const real = realpathSync(path);
      if (!real.startsWith(`${root}${sep}`))
        return new Response("Forbidden", { status: 403 });
      return new Response(Bun.file(real));
    } catch {
      return new Response("Invalid path", { status: 400 });
    }
  },
});
