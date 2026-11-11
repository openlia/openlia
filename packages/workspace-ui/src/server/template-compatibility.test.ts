import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceHandler } from "./app";
import { FeatureService } from "./features";
import {
  checkTemplateRequirements,
  runtimeMeetsMinimum,
} from "./template-compatibility";

describe("template runtime compatibility", () => {
  test("minimum version ordering matches the operator contract", () => {
    for (const [version, minimum, expected] of [
      ["1.2.3", ">=1.2.3", true],
      ["v1.2.3+build.42", ">=1.2.3", true],
      ["1.2.3-rc.1", ">=1.2.3", false],
      ["1.2.4-rc.1", ">=1.2.3", true],
      ["1.2.2", ">=1.2.3", false],
      ["1.10.0", ">=1.9.0", true],
      ["0.99.99", ">=1.0.0", false],
      ["2.0.0", ">=1.99.99", true],
    ] as const) {
      expect(runtimeMeetsMinimum(version, minimum)).toBe(expected);
    }
    for (const version of ["unknown", "1.2", "01.2.3", "1.2.3-01", "1.2.3\n"]) {
      expect(() => runtimeMeetsMinimum(version, ">=1.2.3")).toThrow();
    }
  });

  test("malformed declarations fail and legacy content needs no identity", () => {
    const unavailable = () => {
      throw new Error("target unavailable");
    };
    for (const requires of [undefined, {}, { tools: ["remind"] }]) {
      expect(() =>
        checkTemplateRequirements(requires, "test", unavailable),
      ).not.toThrow();
    }
    for (const openlia of [
      "",
      null,
      1,
      [],
      {},
      "^1.2.3",
      ">=01.2.3",
      ">=1.2",
      ">=1.2.3-rc.1",
      ">=1.2.3\n",
    ]) {
      expect(() =>
        checkTemplateRequirements({ openlia }, "test", () => "9.0.0"),
      ).toThrow("minimum stable version");
    }
  });
});

describe("browser feature installs", () => {
  let root: string;
  let service: FeatureService;
  const put = (path: string, data: string) => {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, data);
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openlia-compatibility-test-"));
    service = new FeatureService({
      workspaceRoot: join(root, "workspace"),
      skillsRoot: join(root, "skills"),
      featuresRoot: join(root, "catalog"),
      runtimeReleasePath: join(root, "runtime-release.json"),
    });
    put(
      "runtime-release.json",
      JSON.stringify({ schema: 1, openlia: "1.0.0" }),
    );
    put(
      "catalog/future/feature.yaml",
      "schema: 1\nid: future\nname: Future\nversion: 1.0.0\nrequires: {openlia: '>=2.0.0'}\n",
    );
    put("catalog/future/workspace/future/note.md", "starter");
    put(
      "catalog/parent/feature.yaml",
      "schema: 1\nid: parent\nname: Parent\nversion: 1.0.0\nrequires: {features: [legacy, future]}\n",
    );
    put(
      "catalog/legacy/feature.yaml",
      "schema: 1\nid: legacy\nname: Legacy\nversion: 1.0.0\n",
    );
    put("catalog/legacy/workspace/legacy/note.md", "legacy starter");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("rejects the complete graph before copying an earlier dependency", () => {
    expect(() => service.install("parent")).toThrow(
      "detected deployed runtime 1.0.0",
    );
    expect(existsSync(join(root, "workspace"))).toBe(false);
    expect(existsSync(join(root, "skills"))).toBe(false);
  });

  test("rejects bundled skill requirements before copying workspace content", () => {
    put(
      "catalog/legacy/feature.yaml",
      "schema: 1\nid: legacy\nname: Legacy\nversion: 1.0.0\nskills: [{id: child, path: skills/child}]\n",
    );
    put(
      "catalog/legacy/skills/child/SKILL.md",
      "---\nname: child\ndescription: Child\nrequires: {openlia: '>=2.0.0'}\n---\nTest\n",
    );
    expect(() => service.install("legacy")).toThrow(
      "skill child requires OpenLia >=2.0.0",
    );
    expect(existsSync(join(root, "workspace"))).toBe(false);
  });

  test("requires baked identity but legacy content still installs without it", () => {
    rmSync(join(root, "runtime-release.json"));
    expect(() => service.install("future")).toThrow(
      "Cannot verify deployed Workspace UI release identity",
    );
    expect(existsSync(join(root, "workspace"))).toBe(false);
    service.install("legacy");
    expect(readFileSync(join(root, "workspace/legacy/note.md"), "utf8")).toBe(
      "legacy starter",
    );
  });

  test("compatible target installs successfully", () => {
    put(
      "runtime-release.json",
      JSON.stringify({ schema: 1, openlia: "2.0.0" }),
    );
    service.install("future");
    expect(readFileSync(join(root, "workspace/future/note.md"), "utf8")).toBe(
      "starter",
    );
  });

  test("discovery and install results expose the selected catalog identity", () => {
    const catalog = {
      schema: 1,
      source: "https://github.com/openlia/catalog.git",
      ref: "a".repeat(40),
      revision: "a".repeat(40),
      mode: "git",
      dirty: false,
      content_sha256: "b".repeat(64),
    } as const;
    put(".openlia-catalog.json", JSON.stringify(catalog));
    const list = service.list();
    expect(list.catalog).toEqual(catalog);
    expect(
      list.features.find((feature) => feature.id === "future")
        ?.requires_openlia,
    ).toBe(">=2.0.0");
    expect(service.install("legacy").catalog).toEqual(catalog);
  });

  test("rejects dependency cycles", () => {
    put(
      "catalog/legacy/feature.yaml",
      "schema: 1\nid: legacy\nname: Legacy\nversion: 1.0.0\nrequires: {features: [parent]}\n",
    );
    expect(() => service.install("parent")).toThrow(
      "cyclic feature dependency",
    );
    expect(existsSync(join(root, "workspace"))).toBe(false);
  });

  for (const location of ["active", "disabled"] as const) {
    test(`refuses ${location} skill replacement before any dependency writes`, () => {
      put(
        "catalog/future/feature.yaml",
        "schema: 1\nid: future\nname: Future\nversion: 1.0.0\nskills: [{id: child, path: skills/child}]\n",
      );
      put(
        "catalog/future/skills/child/SKILL.md",
        "---\nname: child\ndescription: Child\n---\nupstream\n",
      );
      const path =
        location === "active"
          ? "skills/child/SKILL.md"
          : "skills/.openlia-disabled/child/SKILL.md";
      put(path, "user customization and lineage\n");
      expect(() => service.install("parent")).toThrow("use the managed CLI");
      expect(existsSync(join(root, "workspace"))).toBe(false);
      expect(readFileSync(join(root, path), "utf8")).toBe(
        "user customization and lineage\n",
      );
    });
  }

  test("Go and browser installers consume the same flow-style fixture", () => {
    const manifest = readFileSync(
      new URL(
        "../../../../tests/fixtures/templates/feature-flow.yaml",
        import.meta.url,
      ),
      "utf8",
    );
    put("catalog/yaml-contract/feature.yaml", manifest);
    put(
      "catalog/yaml-contract/skills/yaml-child/SKILL.md",
      "---\nname: yaml-child\ndescription: Child\n---\nTest\n",
    );
    put("catalog/yaml-contract/workspace/yaml-contract/note.md", "starter");
    const result = service.install("yaml-contract");
    expect(result.installed_skills).toEqual(["yaml-child"]);
    expect(result.installed_domains).toEqual(["yaml-contract"]);
    expect(
      readFileSync(join(root, "skills/yaml-child/SKILL.md"), "utf8"),
    ).toContain("name: yaml-child");
  });

  test("exposes declared requirements (including hledger) and domain details in list()", () => {
    put(
      "catalog/personal-finance/feature.yaml",
      [
        "schema: 1",
        "id: personal-finance",
        "name: Personal Finance",
        "version: 0.1.0",
        "description: Finance domains and hledger journals.",
        "requires:",
        "  openlia: '>=0.1.0'",
        "  core_domains: [inbox, knowledge]",
        "  tools: [hledger]",
        "domains:",
        "  - path: finance",
        "    label: Finance",
        "    purpose: Top-level financial records.",
        "    lifecycle: active -> archived",
        "skills:",
        "  - id: personal-finance",
        "    path: skills/personal-finance",
      ].join("\n"),
    );

    const listed = service.list();
    const finance = listed.features.find((f) => f.id === "personal-finance");
    expect(finance?.requires).toEqual({
      openlia: ">=0.1.0",
      core_domains: ["inbox", "knowledge"],
      tools: ["hledger"],
    });
    expect(finance?.domain_details?.[0]?.label).toBe("Finance");
  });

  test("rejects unsupported required tools before writing any files", () => {
    put(
      "catalog/bad-tool/feature.yaml",
      "schema: 1\nid: bad-tool\nname: Bad Tool\nversion: 1.0.0\nrequires: {tools: [nonexistent-cli]}\n",
    );
    expect(() => service.install("bad-tool")).toThrow(
      'requires unsupported tool "nonexistent-cli"',
    );
    expect(existsSync(join(root, "workspace"))).toBe(false);
  });

  test("HTTP handler installs features and exposes discoverable domains", async () => {
    put(
      "catalog/personal-health/feature.yaml",
      [
        "schema: 1",
        "id: personal-health",
        "name: Personal Health",
        "version: 0.1.0",
        "requires: {openlia: '>=0.1.0'}",
        "domains:",
        "  - path: health",
        "    label: Health",
        "    purpose: Top-level health domain",
        "    lifecycle: active -> archived",
        "  - path: health/profiles",
        "    label: Health Profiles",
        "    purpose: Baseline health profiles",
        "    lifecycle: active -> archived",
        "skills:",
        "  - id: personal-health",
        "    path: skills/personal-health",
      ].join("\n"),
    );
    put(
      "catalog/personal-health/workspace/health/profiles/profile-template.md",
      "---\ntitle: Profile\n---\n# Profile\n",
    );
    put(
      "catalog/personal-health/skills/personal-health/SKILL.md",
      "---\nname: personal-health\ndescription: Health skill\n---\n# Health\n",
    );

    mkdirSync(join(root, "workspace"), { recursive: true });
    mkdirSync(join(root, "skills"), { recursive: true });
    const handler = createWorkspaceHandler({
      authRequired: false,
      featuresRoot: join(root, "catalog"),
      runtimeReleasePath: join(root, "runtime-release.json"),
      sharesDatabasePath: join(root, "shares.sqlite"),
      skillsRoot: join(root, "skills"),
      workspaceRoot: join(root, "workspace"),
    });

    const installHealth = await handler(
      new Request("http://localhost/api/features/install", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({ id: "personal-health" }),
      }),
    );
    expect(installHealth.status).toBe(200);

    // Verify top-level health domain and health/profiles are both discoverable in /api/workspace/creatable-domains
    const domainsRes = await handler(
      new Request("http://localhost/api/workspace/creatable-domains"),
    );
    const domainsBody = (await domainsRes.json()) as {
      domains: Array<{ path: string }>;
    };
    const domainPaths = domainsBody.domains.map((d) => d.path);
    expect(domainPaths).toContain("health");
    expect(domainPaths).toContain("health/profiles");
  });
});
