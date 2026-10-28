/** Runtime-owned, real-catalog contract checks. Called by the Python runner. */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";
import { FeatureService } from "../src/server/features";
import {
  validateOpenUIContent,
  validateProjectManifest,
} from "../src/server/validator";

const templates = resolve(process.argv[2] ?? "");
const sandbox = resolve(process.argv[3] ?? "");
if (!process.argv[2] || !process.argv[3] || templates === sandbox) {
  throw new Error(
    "usage: bun scripts/check-templates.ts TEMPLATES_ROOT SANDBOX",
  );
}
mkdirSync(sandbox, { recursive: true });
const runtimeReleasePath = resolve(
  import.meta.dir,
  "../../../release/manifest.json",
);
const runtime = JSON.parse(readFileSync(runtimeReleasePath, "utf8"));
const checked: Array<{ id: string; version: string; diagnostics: number }> = [];

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`catalog symlink: ${path}`);
    return entry.isDirectory() ? files(path) : [path];
  });
}

for (const entry of readdirSync(join(templates, "features"), {
  withFileTypes: true,
})) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
  const manifest = YAML.parse(
    readFileSync(
      join(templates, "features", entry.name, "feature.yaml"),
      "utf8",
    ),
  );
  const root = join(sandbox, `install-${entry.name}`);
  const workspaceRoot = join(root, "workspace");
  new FeatureService({
    workspaceRoot,
    skillsRoot: join(root, "skills"),
    featuresRoot: join(templates, "features"),
    runtimeReleasePath,
  }).install(manifest.id);
  let diagnostics = 0;
  if (existsSync(workspaceRoot)) {
    for (const path of files(workspaceRoot)) {
      const rel = relative(workspaceRoot, path).replaceAll("\\", "/");
      const content = readFileSync(path, "utf8");
      const result = path.endsWith("project-manifest.toml")
        ? validateProjectManifest(workspaceRoot, rel, content)
        : path.endsWith(".openui")
          ? validateOpenUIContent(workspaceRoot, rel, content)
          : undefined;
      if (result) {
        diagnostics++;
        if (!result.valid) {
          throw new Error(`${manifest.id}/${rel}: ${result.errors.join("; ")}`);
        }
      }
    }
  }
  checked.push({ id: manifest.id, version: manifest.version, diagnostics });
}

// Exercise the enforcing implementation against an older target identity using
// a scratch copy of the actual Calendar package. This is a guard regression,
// not evidence of behavior of an old binary that predates the guard.
const calendarSource = join(templates, "features/calendar");
if (!existsSync(calendarSource))
  throw new Error("Calendar acceptance package is missing");
const negative = join(sandbox, "older-target");
const calendarCopy = join(negative, "catalog/calendar");
mkdirSync(join(negative, "catalog"), { recursive: true });
cpSync(calendarSource, calendarCopy, { recursive: true });
const manifestPath = join(calendarCopy, "feature.yaml");
const manifest = YAML.parse(readFileSync(manifestPath, "utf8"));
manifest.requires = { ...manifest.requires, openlia: `>=${runtime.openlia}` };
writeFileSync(manifestPath, YAML.stringify(manifest));
const oldIdentity = join(negative, "runtime-release.json");
writeFileSync(oldIdentity, JSON.stringify({ schema: 1, openlia: "0.0.0" }));
const oldWorkspace = join(negative, "workspace");
let rejected = false;
try {
  new FeatureService({
    workspaceRoot: oldWorkspace,
    skillsRoot: join(negative, "skills"),
    featuresRoot: join(negative, "catalog"),
    runtimeReleasePath: oldIdentity,
  }).install("calendar");
} catch (error) {
  if (
    error instanceof Error &&
    error.message.includes("detected deployed runtime 0.0.0")
  ) {
    rejected = true;
  } else throw error;
}
if (
  !rejected ||
  existsSync(oldWorkspace) ||
  existsSync(join(negative, "skills"))
) {
  throw new Error(
    "older-target compatibility rejection did not preserve installed state",
  );
}
const report = {
  schema: 1,
  runtime_version: runtime.openlia,
  features: checked,
  older_target_guard:
    "passed (synthetic older identity, real Calendar content)",
};
writeFileSync(
  join(sandbox, "catalog-checks.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
