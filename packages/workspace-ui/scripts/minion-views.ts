import { MinionViewService } from "../src/server/minion-views";
import { lstatSync } from "node:fs";
import { CalendarService } from "../src/server/calendar";
import { WorkspaceService } from "../src/server/workspace";

// Trusted runtime CLI. No app imports, shell commands, dependencies or mutations.
try {
  const input = await Bun.stdin.text();
  if (Buffer.byteLength(input) > 16384)
    throw new Error("Request exceeds 16 KiB");
  const request = JSON.parse(input);
  const workspaceRoot =
    process.env.OPENLIA_WORKSPACE_ROOT ?? "/opt/data/workspace";
  const rootStat = lstatSync(workspaceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Choose an existing workspace directory");
  const workspace = new WorkspaceService({
    workspaceRoot,
    maintainerDatabasePath: ":memory:",
  });
  const service = new MinionViewService(
    workspace,
    new CalendarService(
      workspace,
      process.env.OPENLIA_TIMEZONE ?? process.env.TZ ?? "UTC",
    ),
  );
  const result =
    request.action === "list"
      ? service.list()
      : request.action === "describe"
        ? service.describe(request.id)
        : request.action === "query"
          ? await service.query(request.query)
          : (() => {
              throw new Error("Unknown action");
            })();
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(
    JSON.stringify({
      schema: 1,
      status: "unavailable",
      message:
        error instanceof Error ? error.message : "View service unavailable",
    }),
  );
  process.exitCode = 1;
}
