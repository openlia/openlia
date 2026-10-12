import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(
  process.env.OPENLIA_WORKSPACE_ROOT ?? join(packageRoot, ".preview-workspace"),
);
const skillsRoot = resolve(
  process.env.OPENLIA_SKILLS_ROOT ?? join(packageRoot, ".preview-skills"),
);
const port = process.env.OPENLIA_WORKSPACE_UI_PORT ?? "8089";
const memoriesRoot = resolve(
  process.env.OPENLIA_MEMORIES_ROOT ?? join(packageRoot, ".preview-memories"),
);

mkdirSync(workspaceRoot, { recursive: true });
const examplePath = join(workspaceRoot, "notes.md");
if (!existsSync(examplePath))
  writeFileSync(
    examplePath,
    "# Workspace UI\n\nThis is the production build preview.\n",
  );

mkdirSync(skillsRoot, { recursive: true });
mkdirSync(memoriesRoot, { recursive: true });

const server = Bun.spawn(["bun", "dist/server.js"], {
  cwd: packageRoot,
  env: {
    ...process.env,
    OPENLIA_SKILLS_ROOT: skillsRoot,
    OPENLIA_MEMORIES_ROOT: memoriesRoot,
    OPENLIA_WORKSPACE_ROOT: workspaceRoot,
    OPENLIA_WORKSPACE_UI_AUTH_REQUIRED: "false",
    OPENLIA_WORKSPACE_UI_BIND: "127.0.0.1",
    OPENLIA_WORKSPACE_UI_PORT: port,
  },
  stderr: "inherit",
  stdout: "inherit",
});

let stopping = false;
function stop() {
  stopping = true;
  server.kill();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(`workspace-ui preview: http://127.0.0.1:${port}`);
const exitCode = await server.exited;
process.exit(stopping ? 0 : exitCode);
