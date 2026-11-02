import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FeatureService } from "./features";
import {
  compileMinionConfig,
  featureMinionPackages,
  initializeFeatureMinions,
  MINION_PACKAGE_FILE,
  portableMinionFile,
  readMinionPackage,
} from "./minion-distribution";
import { MinionService } from "./minions";

describe("Minion distribution", () => {
  let root: string;
  const put = (path: string, value: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openlia-minion-package-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(requiredSetting = false) {
    const feature = join(root, "catalog/demo-app");
    const app = join(feature, "workspace/minions/demo");
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: requiredSetting ? ["trigger", "endpoint"] : ["trigger"],
      properties: {
        trigger: {
          type: "object",
          default: { on_new_entry: true, cron: "0 * * * *" },
        },
        target: { type: "integer", default: 3 },
      },
    };
    const files = {
      "README.md": "---\nname: Demo\n---\n# Demo\n",
      "dashboard.openui":
        'Callout(variant: "info", title: "Demo", description: "Configure this app before use.")',
      "input.openui":
        'Form(name: "minionInput", fields: [], buttons: Buttons(buttons: []))',
      "input.schema.json": '{"type":"object"}',
      "config.schema.json": JSON.stringify(schema),
      "main.py":
        'from pathlib import Path\nPath("ran.txt").write_text("executed")\n',
      "input.py":
        'from pathlib import Path\nPath("ran.txt").write_text("executed")\n',
      "scripts/helper.py": "# helper\n",
      "tests/test_main.py": "# reviewed test\n",
      "tests/fixtures/example.json": '{"example":true}',
      "requirements.txt": "# no hooks\n",
    };
    for (const [name, content] of Object.entries(files))
      put(join(app, name), content);
    put(
      join(app, MINION_PACKAGE_FILE),
      JSON.stringify({ schema: 1, files: Object.keys(files) }),
    );
    put(
      join(feature, "feature.yaml"),
      "schema: 1\nid: demo-app\nname: Demo\nversion: 1.0.0\ndescription: Test app\ndomains:\n  - path: minions/demo\n    kind: extension\n    label: Demo\n    purpose: Test\n    lifecycle: active\n",
    );
    const workspace = join(root, "recipient/workspace");
    const features = new FeatureService({
      workspaceRoot: workspace,
      skillsRoot: join(root, "recipient/skills"),
      featuresRoot: join(root, "catalog"),
    });
    return { app, feature, workspace, features, schema };
  }

  test("shares path safety fixtures with Go", () => {
    const cases = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dir,
          "../../../../tests/fixtures/minion-package-paths.json",
        ),
        "utf8",
      ),
    );
    for (const path of cases.allowed)
      expect(portableMinionFile(path)).toBe(true);
    for (const path of cases.rejected)
      expect(portableMinionFile(path)).toBe(false);
  });

  test("shares configuration default and pending-state fixtures with Go", () => {
    const cases = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dir,
          "../../../../tests/fixtures/minion-config-defaults.json",
        ),
        "utf8",
      ),
    );
    for (const item of cases) {
      expect(compileMinionConfig(item.schema).defaults ?? null).toEqual(
        item.expected,
      );
    }
  });

  test("exports complete reviewed code but never config/state, even with include_records", () => {
    const { app, feature } = fixture();
    put(join(app, "config.json"), '{"trigger":"both","target":99}');
    put(join(app, "data/private.json"), "creator records");
    put(join(app, "node_modules/pkg/index.js"), "dependency");
    const features = new FeatureService({
      workspaceRoot: join(feature, "workspace"),
      skillsRoot: join(root, "skills"),
      featuresRoot: join(root, "empty"),
    });
    for (const includeRecords of [false, true]) {
      const captured = features.captureFeatureFiles("demo-app", {
        domains: ["minions/demo"],
        include_records: includeRecords,
      });
      const paths = captured.files.map((file) => file.path);
      for (const name of [
        "main.py",
        "dashboard.openui",
        "scripts/helper.py",
        "tests/test_main.py",
        "tests/fixtures/example.json",
        MINION_PACKAGE_FILE,
      ]) {
        expect(paths).toContain(`workspace/minions/demo/${name}`);
      }
      for (const name of [
        "config.json",
        "data/private.json",
        "node_modules/pkg/index.js",
      ])
        expect(paths).not.toContain(`workspace/minions/demo/${name}`);
    }
    for (const path of ["minions", "minions/demo/data", "minions/Bad_ID"]) {
      expect(() =>
        features.captureFeatureFiles("demo-app", {
          domains: [path],
          include_records: true,
        }),
      ).toThrow("exact minions/<slug>");
    }
  });

  test("installs without execution and initializes schema defaults with triggers off", () => {
    const { workspace, features } = fixture();
    const result = features.install("demo-app");
    expect(result.minions).toEqual([
      { id: "demo", configuration_required: false },
    ]);
    const app = join(workspace, "minions/demo");
    expect(JSON.parse(readFileSync(join(app, "config.json"), "utf8"))).toEqual({
      trigger: { on_new_entry: false },
      target: 3,
    });
    expect(existsSync(join(app, "ran.txt"))).toBe(false);
    expect(existsSync(join(app, "data"))).toBe(false);
    expect(existsSync(join(app, "scripts/helper.py"))).toBe(true);
  });

  test("leaves missing user settings pending and blocks all app execution paths", async () => {
    const { workspace, features } = fixture(true);
    expect(features.install("demo-app").minions).toEqual([
      { id: "demo", configuration_required: true },
    ]);
    const app = join(workspace, "minions/demo");
    expect(existsSync(join(app, "config.json"))).toBe(false);
    const minions = new MinionService({ workspaceRoot: workspace });
    expect(minions.getMinion("demo").minion.configuration_required).toBe(true);
    expect(minions.getMinion("demo").minion.triggers).toEqual({
      after_entry: false,
    });
    await expect(minions.runMinionHeartbeat("demo")).rejects.toThrow(
      "needs valid local configuration",
    );
    await expect(
      minions.submitMinionInput("demo", { data: {} }),
    ).rejects.toThrow("needs valid local configuration");
    await expect(
      minions.runMinion("demo", { trigger: "entry", data: {} }),
    ).rejects.toThrow("needs valid local configuration");
    expect(existsSync(join(app, "ran.txt"))).toBe(false);
    minions.updateMinionConfig("demo", {
      trigger: { on_new_entry: false },
      target: 3,
      endpoint: "configured",
    });
    expect(minions.getMinion("demo").minion.configuration_required).toBe(false);
  });

  test("browser reinstall refuses before touching instance state; remove preserves app files", () => {
    const { workspace, features } = fixture();
    features.install("demo-app");
    const app = join(workspace, "minions/demo");
    const config = '{"trigger":{"on_new_entry":true},"target":17}';
    put(join(app, "config.json"), config);
    put(join(app, "data/entries.json"), "recipient data");
    expect(() => features.install("demo-app")).toThrow("use the managed CLI");
    expect(readFileSync(join(app, "config.json"), "utf8")).toBe(config);
    features.remove("demo-app");
    expect(readFileSync(join(app, "config.json"), "utf8")).toBe(config);
    expect(readFileSync(join(app, "data/entries.json"), "utf8")).toBe(
      "recipient data",
    );
    expect(existsSync(join(app, "main.py"))).toBe(true);
  });

  test("rejects local files, missing/unsafe manifests, credentials, and symlinks before writes", () => {
    for (const scenario of [
      "state",
      "extra",
      "unsafe-list",
      "duplicate-case",
      "mixed-input",
      "missing-manifest",
      "credential",
      "source-symlink",
      "destination-symlink",
    ]) {
      const caseRoot = join(root, scenario);
      mkdirSync(caseRoot);
      const original = root;
      root = caseRoot;
      try {
        const { app, workspace, features } = fixture();
        if (scenario === "state")
          put(join(app, "data/private.json"), "private");
        if (scenario === "extra") put(join(app, "extra.py"), "# not reviewed");
        if (scenario === "unsafe-list")
          put(
            join(app, MINION_PACKAGE_FILE),
            JSON.stringify({ schema: 1, files: ["config.json"] }),
          );
        if (scenario === "duplicate-case" || scenario === "mixed-input") {
          const manifest = JSON.parse(
            readFileSync(join(app, MINION_PACKAGE_FILE), "utf8"),
          );
          const name = scenario === "duplicate-case" ? "readme.md" : "input.ts";
          if (scenario === "mixed-input")
            put(join(app, name), "// wrong input runtime");
          manifest.files.push(name);
          put(join(app, MINION_PACKAGE_FILE), JSON.stringify(manifest));
        }
        if (scenario === "missing-manifest")
          rmSync(join(app, MINION_PACKAGE_FILE));
        if (scenario === "credential")
          put(join(app, "main.py"), "# -----BEGIN PRIVATE KEY-----");
        if (scenario === "source-symlink") {
          rmSync(join(app, "main.py"));
          symlinkSync("input.py", join(app, "main.py"));
        }
        if (scenario === "destination-symlink") {
          mkdirSync(workspace, { recursive: true });
          mkdirSync(join(root, "outside"));
          symlinkSync(join(root, "outside"), join(workspace, "minions"));
        }
        expect(() => features.install("demo-app")).toThrow();
        expect(existsSync(join(workspace, "minions/demo/main.py"))).toBe(false);
      } finally {
        root = original;
      }
    }
  });

  test("configuration initialization preserves existing bytes, including invalid settings", () => {
    const { app, feature, workspace, schema } = fixture();
    const packages = featureMinionPackages(join(feature, "workspace"), [
      { path: "minions/demo" },
    ]);
    const config = "{ invalid local config";
    put(join(workspace, "minions/demo/config.json"), config);
    expect(initializeFeatureMinions(workspace, packages)).toEqual([
      { id: "demo", configuration_required: true },
    ]);
    expect(
      readFileSync(join(workspace, "minions/demo/config.json"), "utf8"),
    ).toBe(config);
    expect(() =>
      compileMinionConfig({
        ...schema,
        $ref: "https://example.invalid/schema",
      }),
    ).toThrow();
    expect(readMinionPackage(app, "demo").files).toContain(
      "tests/fixtures/example.json",
    );
  });
});
