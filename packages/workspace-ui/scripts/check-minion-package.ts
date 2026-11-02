/** Cross-language fixture runner; all paths are disposable test directories. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FeatureService } from "../src/server/features";

const [mode, source, destination] = process.argv.slice(2);
if (!source || !destination || !["export", "install"].includes(mode ?? "")) {
  throw new Error(
    "usage: check-minion-package.ts export|install SOURCE DESTINATION",
  );
}
if (mode === "export") {
  const features = new FeatureService({
    workspaceRoot: join(source, "workspace"),
    skillsRoot: join(source, "skills"),
    featuresRoot: join(source, "empty-catalog"),
  });
  const archive = features.packageZip({
    id: "demo-app",
    domains: ["minions/demo"],
    include_records: true,
  });
  writeFileSync(destination, archive.zipBytes);
} else {
  const workspace = join(destination, "workspace");
  mkdirSync(destination, { recursive: true });
  const features = new FeatureService({
    workspaceRoot: workspace,
    skillsRoot: join(destination, "skills"),
    featuresRoot: source,
  });
  const result = features.install("demo-app");
  if (result.minions?.[0]?.configuration_required !== false)
    throw new Error("missing initialized configuration");
  const config = JSON.parse(
    readFileSync(join(workspace, "minions/demo/config.json"), "utf8"),
  );
  if (
    config.trigger.on_new_entry !== false ||
    config.trigger.cron ||
    config.target !== 3
  )
    throw new Error("unsafe recipient defaults");
  for (const path of [
    "main.py",
    "dashboard.openui",
    "scripts/helper.py",
    "tests/test_main.py",
  ]) {
    if (!existsSync(join(workspace, "minions/demo", path)))
      throw new Error(`missing portable code: ${path}`);
  }
  if (existsSync(join(workspace, "minions/demo/data")))
    throw new Error("creator records were distributed");
}
