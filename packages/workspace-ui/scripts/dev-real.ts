import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(
  process.env.OPENLIA_WORKSPACE_ROOT ?? join(packageRoot, ".dev-workspace"),
);
const skillsRoot = resolve(
  process.env.OPENLIA_SKILLS_ROOT ?? join(packageRoot, ".dev-skills"),
);
const memoriesRoot = resolve(
  process.env.OPENLIA_MEMORIES_ROOT ??
    (process.env.HERMES_HOME
      ? join(process.env.HERMES_HOME, "memories")
      : join(packageRoot, ".dev-memories")),
);
const backendPort = process.env.OPENLIA_WORKSPACE_UI_PORT ?? "8089";
const frontendPort = process.env.OPENLIA_WORKSPACE_UI_DEV_PORT ?? "5173";
const backendUrl = `http://127.0.0.1:${backendPort}`;
const ingestionRoot =
  process.env.OPENLIA_INGESTION_ROOT ??
  (process.env.HERMES_HOME
    ? join(process.env.HERMES_HOME, "ingestion")
    : undefined);

mkdirSync(workspaceRoot, { recursive: true });
const examplePath = join(workspaceRoot, "notes.md");
if (!existsSync(examplePath))
  writeFileSync(
    examplePath,
    "# Workspace UI\n\nEdit this document while developing the real backend.\n",
  );

mkdirSync(skillsRoot, { recursive: true });
mkdirSync(memoriesRoot, { recursive: true });
if (!process.env.OPENLIA_MEMORIES_ROOT && !process.env.HERMES_HOME) {
  for (const name of ["USER.md", "MEMORY.md"]) {
    const path = join(memoriesRoot, name);
    if (!existsSync(path))
      writeFileSync(
        path,
        `# ${name === "USER.md" ? "User profile" : "Assistant memory"}\n\nSample memory for local development.\n`,
      );
  }
}
const sampleSkillDir = join(skillsRoot, "sample-skill");
mkdirSync(sampleSkillDir, { recursive: true });
const sampleSkillMd = join(sampleSkillDir, "SKILL.md");
if (!existsSync(sampleSkillMd)) {
  writeFileSync(
    sampleSkillMd,
    "---\nname: sample-skill\ndescription: Sample skill for local development\nversion: 1.0.0\n---\n# Sample Skill\n\nInstructions for Hermes.\n",
  );
}

const environment = {
  ...process.env,
  OPENLIA_SKILLS_ROOT: skillsRoot,
  OPENLIA_MEMORIES_ROOT: memoriesRoot,
  ...(ingestionRoot ? { OPENLIA_INGESTION_ROOT: ingestionRoot } : {}),
  OPENLIA_WORKSPACE_ROOT: workspaceRoot,
  OPENLIA_WORKSPACE_UI_AUTH_REQUIRED: "false",
  OPENLIA_WORKSPACE_UI_BIND: "127.0.0.1",
  OPENLIA_WORKSPACE_UI_PORT: backendPort,
  OPENLIA_WORKSPACE_UI_BACKEND_URL: backendUrl,
  VITE_WORKSPACE_UI_MODE: "real",
};

const children = [
  Bun.spawn(["bun", "--watch", "src/server/main.ts"], {
    cwd: packageRoot,
    env: environment,
    stderr: "inherit",
    stdout: "inherit",
  }),
  Bun.spawn(["bun", "run", "vite"], {
    cwd: packageRoot,
    env: environment,
    stderr: "inherit",
    stdout: "inherit",
  }),
];

let stopping = false;
function stopChildren() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}

process.on("SIGINT", stopChildren);
process.on("SIGTERM", stopChildren);

console.log(`workspace-ui frontend: http://127.0.0.1:${frontendPort}`);
console.log(`workspace-ui backend:  ${backendUrl}`);
console.log(`workspace root:        ${workspaceRoot}`);
console.log(`skills root:           ${skillsRoot}`);

const exitCode = await Promise.race(children.map((child) => child.exited));
const unexpectedExit = !stopping && exitCode !== 0;
stopChildren();
process.exit(unexpectedExit ? 1 : 0);
