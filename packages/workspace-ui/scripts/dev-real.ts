import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  financeAccountTemplate,
  financeAccountSchema,
  financeProgram,
  financeJournalFiles,
} from "../test-fixtures/finance";

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
const cronRoot =
  process.env.OPENLIA_CRON_ROOT ??
  (process.env.HERMES_HOME
    ? join(process.env.HERMES_HOME, "cron")
    : join(packageRoot, ".dev-cron"));
const e2eFixture = process.env.WORKSPACE_UI_E2E_FIXTURE === "true";

mkdirSync(workspaceRoot, { recursive: true });
const examplePath = join(workspaceRoot, "notes.md");
if (!existsSync(examplePath))
  writeFileSync(
    examplePath,
    "# Workspace UI\n\nEdit this document while developing the real backend.\n",
  );

if (!process.env.OPENLIA_WORKSPACE_ROOT || e2eFixture) {
  mkdirSync(join(workspaceRoot, "archive"), { recursive: true });
  const readmePath = join(workspaceRoot, "README.md");
  if (!existsSync(readmePath))
    writeFileSync(
      readmePath,
      "# Real workspace fixture\n\nThis file verifies the Bun-backed workspace path.\n",
    );
  const calendarFixture = join(
    workspaceRoot,
    "calendar",
    "2026-09-23-lunch-marukame-fe-dev-2.md",
  );
  mkdirSync(join(workspaceRoot, "calendar"), { recursive: true });
  if (!existsSync(calendarFixture))
    writeFileSync(
      calendarFixture,
      "# Calendar fixture\n\nCreated for real workspace verification.\n",
    );
}

if (e2eFixture) {
  // Self-contained copy of the Calendar feature's OpenUI integration contract.
  const calendarFiles: Record<string, string> = {
    "project-manifest.toml":
      'version = 1\n[project]\nid = "calendar"\nname = "Calendar"\n[ui]\nentry = "ui.openui"\n',
    "ui.openui":
      'root = Calendar([Tabs([TabItem("month", "Month", [CalendarMonth()]), TabItem("week", "Week", [CalendarWeek()]), TabItem("timeline", "Timeline", [GanttChart()])])])\n',
    "reminders.rem":
      "# Calendar browser fixture\nINCLUDE holidays.rem\nREM Mon AT 09:30 DURATION 30 MSG Weekly standup\n",
    "holidays.rem":
      "# Included calendar fixture\nREM 2026-10-28 THROUGH 2026-10-30 MSG Holiday\n",
  };
  for (const [name, content] of Object.entries(calendarFiles)) {
    const path = join(workspaceRoot, "calendar", name);
    if (!existsSync(path)) writeFileSync(path, content);
  }
  mkdirSync(join(workspaceRoot, "finance/accounts"), { recursive: true });
  const financeFiles: Record<string, string> = {
    "project-manifest.toml":
      'version = 1\n[project]\nid = "finance"\nname = "Personal Finance"\n[ui]\nentry = "ui.openui"\n',
    "ui.openui": financeProgram,
    "accounts/accounts-template.md": financeAccountTemplate,
    "accounts/accounts-template.schema.json":
      JSON.stringify(financeAccountSchema),
    ...financeJournalFiles,
  };
  for (const [name, content] of Object.entries(financeFiles)) {
    const path = join(workspaceRoot, "finance", name);
    if (!existsSync(path)) writeFileSync(path, content);
  }
}

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
  OPENLIA_CRON_ROOT: cronRoot,
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
  Bun.spawn(["bun", "--bun", "run", "vite"], {
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
