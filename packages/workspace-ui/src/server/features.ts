import type { Dirent, Stats } from "node:fs";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type {
  FeatureInstallResponse,
  FeaturePackageRequest,
  FeaturesListResponse,
  FeatureSummary,
  ShareFeatureMetadata,
  TemplatesCatalogProvenance,
} from "../shared/api";
import { createZipArchive, type ZipArchiveEntry } from "./export";
import {
  checkTemplateRequirements,
  readTemplatesRuntimeVersion,
} from "./template-compatibility";
import { WorkspaceError } from "./workspace";

export interface FeatureServiceOptions {
  workspaceRoot: string;
  skillsRoot: string;
  featuresRoot?: string | undefined;
  runtimeReleasePath?: string | undefined;
}

interface RawFeatureDomain {
  path: string;
  kind?: string;
  label: string;
  purpose: string;
  template?: string;
  lifecycle: string;
  feature?: string;
  skills?: string[];
}

interface RawFeatureSkill {
  id: string;
  path: string;
  workspace_domains?: string[];
}

interface RawFeatureManifest {
  schema: number;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  requires?: {
    openlia?: string;
    core_domains?: string[];
    features?: string[];
  };
  domains?: RawFeatureDomain[];
  skills?: RawFeatureSkill[];
  policy?: {
    allowed_domains?: string[];
    allowed_actions?: string[];
  };
}

export function validateFeatureId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceError(
      "feature id is required",
      400,
      "invalid_feature_id",
    );
  }
  const clean = value.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(clean)) {
    throw new WorkspaceError(
      "invalid feature id format",
      400,
      "invalid_feature_id",
    );
  }
  return clean;
}

function resolveDefaultFeaturesRoot(): string {
  for (const envCandidate of [
    process.env.OPENLIA_TEMPLATES_REPO,
    process.env.OPENLIA_TEMPLATES_ROOT,
  ]) {
    if (envCandidate && existsSync(join(envCandidate, "features"))) {
      return resolve(envCandidate, "features");
    }
  }
  if (process.env.OPENLIA_META_ROOT) {
    const cacheFeatures = join(
      process.env.OPENLIA_META_ROOT,
      "templates-cache",
      "features",
    );
    if (existsSync(cacheFeatures)) {
      return resolve(cacheFeatures);
    }
  }
  const repoFeatures = fileURLToPath(
    new URL("../../../../features", import.meta.url),
  );
  if (existsSync(repoFeatures)) {
    return repoFeatures;
  }
  return repoFeatures;
}

export class FeatureService {
  readonly workspaceRoot: string;
  readonly skillsRoot: string;
  readonly featuresRoot: string;
  private readonly runtimeReleasePath: string | undefined;

  constructor(options: FeatureServiceOptions) {
    this.runtimeReleasePath = options.runtimeReleasePath;
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.skillsRoot = resolve(options.skillsRoot);
    this.featuresRoot = options.featuresRoot
      ? resolve(options.featuresRoot)
      : resolveDefaultFeaturesRoot();
  }

  private catalogProvenance(): TemplatesCatalogProvenance | undefined {
    try {
      const value = JSON.parse(
        readFileSync(
          join(this.featuresRoot, "..", ".openlia-catalog.json"),
          "utf8",
        ),
      );
      if (
        value?.schema === 1 &&
        typeof value.source === "string" &&
        typeof value.ref === "string" &&
        typeof value.content_sha256 === "string" &&
        (value.mode === "git" || value.mode === "local-worktree") &&
        typeof value.dirty === "boolean"
      )
        return value;
    } catch {}
    return undefined;
  }

  private readRegisteredDomains(): Map<string, RawFeatureDomain> {
    const map = new Map<string, RawFeatureDomain>();
    const wsYamlPath = join(this.workspaceRoot, "workspace.yaml");
    if (existsSync(wsYamlPath)) {
      try {
        const parsed = YAML.parse(readFileSync(wsYamlPath, "utf8"));
        if (
          parsed &&
          typeof parsed === "object" &&
          Array.isArray(parsed.domains)
        ) {
          for (const d of parsed.domains) {
            if (d && typeof d === "object" && typeof d.path === "string") {
              const cleanPath = d.path
                .replaceAll("\\", "/")
                .replace(/^\/+|\/+$/g, "");
              map.set(cleanPath, { ...d, path: cleanPath });
            }
          }
        }
      } catch {}
    }

    // Discover installed feature domains from the filesystem without requiring workspace.yaml
    const catalog = this.loadCatalogManifests();
    for (const [featureId, { manifest }] of catalog.entries()) {
      for (const d of manifest.domains ?? []) {
        const cleanPath = d.path
          .replaceAll("\\", "/")
          .replace(/^\/+|\/+$/g, "");
        if (map.has(cleanPath)) continue;
        const absDir = join(this.workspaceRoot, cleanPath);
        if (!existsSync(absDir)) continue;
        try {
          if (statSync(absDir).isDirectory()) {
            map.set(cleanPath, {
              ...d,
              path: cleanPath,
              kind: d.kind || "extension",
              feature: featureId,
            });
          }
        } catch {}
      }
    }
    return map;
  }

  private loadCatalogManifests(): Map<
    string,
    { dir: string; manifest: RawFeatureManifest }
  > {
    const map = new Map<
      string,
      { dir: string; manifest: RawFeatureManifest }
    >();
    if (!existsSync(this.featuresRoot)) return map;
    try {
      const entries = readdirSync(this.featuresRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(this.featuresRoot, entry.name);
        const manifestPath = join(dir, "feature.yaml");
        if (!existsSync(manifestPath)) continue;
        try {
          const parsed = YAML.parse(
            readFileSync(manifestPath, "utf8"),
          ) as RawFeatureManifest & {
            title?: string;
            paths?: string[];
          };
          if (parsed && typeof parsed === "object" && parsed.id) {
            if (!parsed.name && parsed.title) {
              parsed.name = parsed.title;
            }
            const rawDomains = Array.isArray(parsed.domains)
              ? parsed.domains
              : Array.isArray(parsed.paths)
                ? parsed.paths
                : [];
            parsed.domains = rawDomains
              .map((d: unknown): RawFeatureDomain | null => {
                if (typeof d === "string" && d.trim()) {
                  const p = d.trim();
                  return {
                    path: p,
                    label: parsed.name || p,
                    purpose: parsed.description || "",
                    lifecycle: "active -> archived",
                  };
                }
                if (
                  d &&
                  typeof d === "object" &&
                  typeof (d as RawFeatureDomain).path === "string"
                ) {
                  return d as RawFeatureDomain;
                }
                return null;
              })
              .filter((d): d is RawFeatureDomain => d !== null);
            const rawSkills = Array.isArray(parsed.skills) ? parsed.skills : [];
            parsed.skills = rawSkills
              .map((s: unknown): RawFeatureSkill | null => {
                if (typeof s === "string" && s.trim()) {
                  const sid = s.trim();
                  return { id: sid, path: `skills/${sid}` };
                }
                if (
                  s &&
                  typeof s === "object" &&
                  typeof (s as RawFeatureSkill).id === "string"
                ) {
                  return s as RawFeatureSkill;
                }
                return null;
              })
              .filter((s): s is RawFeatureSkill => s !== null);
            map.set(parsed.id, { dir, manifest: parsed });
          }
        } catch {}
      }
    } catch {}
    return map;
  }

  list(): FeaturesListResponse {
    const catalog = this.loadCatalogManifests();
    const registered = this.readRegisteredDomains();
    const summaries: FeatureSummary[] = [];
    const seen = new Set<string>();

    for (const [id, { manifest }] of catalog.entries()) {
      seen.add(id);
      const domains = (manifest.domains ?? []).map((d) => d.path);
      const skills = (manifest.skills ?? []).map((s) => s.id);
      let matched = 0;
      for (const dp of domains) {
        if (registered.has(dp)) matched++;
      }
      for (const sk of skills) {
        if (existsSync(join(this.skillsRoot, sk, "SKILL.md"))) matched++;
      }
      const total = domains.length + skills.length;
      const state: FeatureSummary["state"] =
        total > 0 && matched === total
          ? "installed"
          : matched > 0
            ? "partial"
            : "available";
      summaries.push({
        requires_openlia: manifest.requires?.openlia,
        id,
        name: manifest.name || id,
        version: manifest.version || "1.0.0",
        description: manifest.description || "",
        author: manifest.author,
        license: manifest.license,
        source: "builtin",
        state,
        domains,
        skills,
      });
    }

    // Discover custom features referenced in workspace.yaml
    const customByFeature = new Map<string, RawFeatureDomain[]>();
    for (const d of registered.values()) {
      if (d.feature && !seen.has(d.feature)) {
        const list = customByFeature.get(d.feature) ?? [];
        list.push(d);
        customByFeature.set(d.feature, list);
      }
    }
    for (const [id, doms] of customByFeature.entries()) {
      const domains = doms.map((d) => d.path);
      const skillSet = new Set<string>();
      for (const d of doms) {
        for (const s of d.skills ?? []) skillSet.add(s);
      }
      summaries.push({
        id,
        name: id,
        version: "0.1.0",
        description: `Custom workspace feature (${domains.join(", ")})`,
        source: "custom",
        state: "installed",
        domains,
        skills: [...skillSet],
      });
    }

    summaries.sort((a, b) => a.id.localeCompare(b.id));
    return {
      schema: 1,
      ok: true,
      features: summaries,
      catalog: this.catalogProvenance(),
    };
  }

  private preflight(
    featureId: string,
  ): Array<{ dir: string; manifest: RawFeatureManifest }> {
    const catalog = this.loadCatalogManifests();
    const plan: Array<{ dir: string; manifest: RawFeatureManifest }> = [];
    const plannedSkills = new Set<string>();
    const active = new Set<string>();
    const done = new Set<string>();
    let runtimeVersion: string | undefined;
    const version = () => {
      runtimeVersion ??= readTemplatesRuntimeVersion(this.runtimeReleasePath);
      return runtimeVersion;
    };
    const visit = (id: string) => {
      if (active.has(id)) {
        throw new WorkspaceError(
          `cyclic feature dependency at ${id}`,
          400,
          "invalid_template_compatibility",
        );
      }
      if (done.has(id)) return;
      const entry = catalog.get(validateFeatureId(id));
      if (!entry) {
        throw new WorkspaceError(
          `feature not found: ${id}`,
          404,
          "feature_not_found",
        );
      }
      active.add(id);
      checkTemplateRequirements(
        entry.manifest.requires,
        `feature ${id}`,
        version,
      );
      for (const dependency of entry.manifest.requires?.features ?? []) {
        visit(dependency);
      }
      for (const skill of entry.manifest.skills ?? []) {
        validateFeatureId(skill.id);
        const skillRel = relative(entry.dir, resolve(entry.dir, skill.path));
        if (skillRel === ".." || skillRel.startsWith(`..${sep}`)) {
          throw new WorkspaceError(
            "skill source must stay inside its feature",
            400,
            "invalid_skill_path",
          );
        }
        if (plannedSkills.has(skill.id)) {
          throw new WorkspaceError(
            `multiple packages install skill ${skill.id}; use the managed CLI`,
            409,
            "skill_install_requires_cli",
          );
        }
        plannedSkills.add(skill.id);
        for (const destination of [
          join(this.skillsRoot, skill.id),
          join(this.skillsRoot, ".openlia-disabled", skill.id),
        ]) {
          try {
            lstatSync(destination);
          } catch (error) {
            if (
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ENOENT"
            )
              continue;
            throw error;
          }
          throw new WorkspaceError(
            `skill ${skill.id} already exists (active or disabled); use the managed CLI to preserve customizations and lineage`,
            409,
            "skill_install_requires_cli",
          );
        }
        const path = join(entry.dir, skill.path, "SKILL.md");
        if (!existsSync(path))
          throw new WorkspaceError(
            `skill ${skill.id} is missing SKILL.md`,
            400,
            "invalid_skill_package",
          );
        const text = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
        if (!text.startsWith("---\n")) continue;
        const lines = text.slice(4).split("\n");
        const end = lines.indexOf("---");
        if (end < 0) {
          throw new WorkspaceError(
            `skill ${skill.id} has unclosed frontmatter`,
            400,
            "invalid_template_compatibility",
          );
        }
        let frontmatter: { requires?: unknown } | null;
        try {
          frontmatter = YAML.parse(lines.slice(0, end).join("\n"));
        } catch {
          throw new WorkspaceError(
            `skill ${skill.id} has invalid frontmatter`,
            400,
            "invalid_template_compatibility",
          );
        }
        checkTemplateRequirements(
          frontmatter?.requires,
          `skill ${skill.id}`,
          version,
        );
      }
      active.delete(id);
      done.add(id);
      plan.push(entry);
    };
    visit(featureId);
    return plan;
  }

  install(rawId: unknown, _approvePolicy = true): FeatureInstallResponse {
    const featureId = validateFeatureId(rawId);
    const plan = this.preflight(featureId);
    const root = plan.pop();
    if (!root)
      throw new WorkspaceError(
        "empty feature installation plan",
        400,
        "invalid_feature",
      );
    for (const entry of plan) this.installNewEntry(entry.dir, entry.manifest);
    return this.installNewEntry(root.dir, root.manifest);
  }

  private installNewEntry(
    dir: string,
    manifest: RawFeatureManifest,
  ): FeatureInstallResponse {
    const featureId = manifest.id;

    // 2. Copy workspace templates/schemas non-destructively
    const featureWsDir = join(dir, "workspace");
    if (existsSync(featureWsDir)) {
      this.copyTreeOnce(featureWsDir, this.workspaceRoot);
    }

    const installedDomains: string[] = [];
    for (const d of manifest.domains ?? []) {
      mkdirSync(join(this.workspaceRoot, d.path), {
        recursive: true,
        mode: 0o700,
      });
      installedDomains.push(d.path);
    }

    // 3. Legacy workspace.yaml / assistant-policy.yaml updates are retired under Workspace Maintainer.
    const policyUpdated = false;

    // 4. Copy bundled skills
    const installedSkills: string[] = [];
    for (const sk of manifest.skills ?? []) {
      const srcSkillDir = join(dir, sk.path);
      if (existsSync(srcSkillDir)) {
        const dstSkillDir = join(this.skillsRoot, sk.id);
        mkdirSync(dirname(dstSkillDir), { recursive: true, mode: 0o700 });
        // Reserve a new destination exclusively; never merge into an existing
        // active tree, even if another process created it after preflight.
        mkdirSync(dstSkillDir, { mode: 0o700 });
        cpSync(srcSkillDir, dstSkillDir, {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
        installedSkills.push(sk.id);
      }
    }

    return {
      schema: 1,
      ok: true,
      feature_id: featureId,
      installed_domains: installedDomains,
      catalog: this.catalogProvenance(),
      installed_skills: installedSkills,
      policy_updated: policyUpdated,
    };
  }

  remove(rawId: unknown): { schema: 1; ok: true; feature_id: string } {
    const featureId = validateFeatureId(rawId);
    const catalog = this.loadCatalogManifests();
    const entry = catalog.get(featureId);
    const removePaths = new Set<string>(
      (entry?.manifest.domains ?? []).map((d) => d.path),
    );

    // Clean up legacy workspace.yaml if present, and remove empty starter domain directories
    const wsYamlPath = join(this.workspaceRoot, "workspace.yaml");
    if (existsSync(wsYamlPath)) {
      try {
        const parsed = YAML.parse(readFileSync(wsYamlPath, "utf8")) ?? {};
        if (Array.isArray(parsed.domains)) {
          parsed.domains = parsed.domains.filter(
            (d: RawFeatureDomain) =>
              d && !removePaths.has(d.path) && d.feature !== featureId,
          );
          writeFileSync(wsYamlPath, YAML.stringify(parsed), {
            encoding: "utf8",
            mode: 0o600,
          });
        }
      } catch {}
    }

    for (const dp of removePaths) {
      const domDir = join(this.workspaceRoot, dp);
      if (!existsSync(domDir)) continue;
      try {
        const entries = readdirSync(domDir, { withFileTypes: true });
        const hasUserRecords = entries.some(
          (e) =>
            e.isDirectory() ||
            (!e.name.startsWith(".") &&
              !e.name.endsWith("-template.md") &&
              !e.name.endsWith(".schema.json") &&
              e.name !== "project-manifest.toml" &&
              !e.name.endsWith(".openui")),
        );
        if (!hasUserRecords) {
          rmSync(domDir, { recursive: true, force: true });
        }
      } catch {}
    }

    for (const sk of entry?.manifest.skills ?? []) {
      const activeDir = join(this.skillsRoot, sk.id);
      const disabledDir = join(this.skillsRoot, ".openlia-disabled", sk.id);
      if (existsSync(activeDir)) {
        mkdirSync(dirname(disabledDir), { recursive: true, mode: 0o700 });
        rmSync(disabledDir, { recursive: true, force: true });
        renameSync(activeDir, disabledDir);
      }
    }

    return {
      schema: 1,
      ok: true,
      feature_id: featureId,
    };
  }

  captureFeatureFiles(
    rawId: unknown,
    options?: Partial<FeaturePackageRequest>,
  ): {
    metadata: ShareFeatureMetadata;
    files: Array<{ path: string; data: Uint8Array; modifiedAt: string }>;
  } {
    const featureId = validateFeatureId(rawId);
    const catalog = this.loadCatalogManifests();
    const catEntry = catalog.get(featureId);
    const registered = this.readRegisteredDomains();

    let domainPaths = options?.domains?.filter(Boolean) ?? [];
    let skillIds = options?.skills?.filter(Boolean) ?? [];

    if (domainPaths.length === 0 && skillIds.length === 0) {
      if (catEntry) {
        domainPaths = (catEntry.manifest.domains ?? []).map((d) => d.path);
        skillIds = (catEntry.manifest.skills ?? []).map((s) => s.id);
      } else {
        for (const d of registered.values()) {
          if (d.feature === featureId || d.path === featureId) {
            domainPaths.push(d.path);
            for (const s of d.skills ?? []) {
              if (!skillIds.includes(s)) skillIds.push(s);
            }
          }
        }
      }
    }

    if (domainPaths.length === 0 && skillIds.length === 0) {
      throw new WorkspaceError(
        `feature not found or has no domains/skills: ${featureId}`,
        404,
        "feature_not_found",
      );
    }

    const packagedDomains: RawFeatureDomain[] = domainPaths.map((dp) => {
      const clean = dp.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
      const existing =
        registered.get(clean) ??
        catEntry?.manifest.domains?.find((d) => d.path === clean);
      if (existing) {
        return {
          ...existing,
          kind: "extension",
          feature: featureId,
        };
      }
      return {
        path: clean,
        kind: "extension",
        label: clean.split("/").at(-1) ?? clean,
        purpose: `Records for ${clean}`,
        lifecycle: "active -> archived",
        feature: featureId,
      };
    });

    const name = options?.name?.trim() || catEntry?.manifest.name || featureId;
    const version =
      options?.version?.trim() || catEntry?.manifest.version || "0.1.0";
    const description =
      options?.description?.trim() ||
      catEntry?.manifest.description ||
      `Packaged OpenLia feature ${featureId}`;

    const manifestObj: RawFeatureManifest = {
      schema: 1,
      id: featureId,
      name,
      version,
      description,
      ...(catEntry?.manifest.author
        ? { author: catEntry.manifest.author }
        : {}),
      ...(catEntry?.manifest.license
        ? { license: catEntry.manifest.license }
        : {}),
      requires: catEntry?.manifest.requires ?? {
        core_domains: ["inbox", "archive"],
      },
      domains: packagedDomains,
      ...(skillIds.length > 0
        ? {
            skills: skillIds.map((sk) => ({
              id: sk,
              path: `skills/${sk}`,
              workspace_domains: packagedDomains.map((d) => d.path),
            })),
          }
        : {}),
      policy: catEntry?.manifest.policy ?? {
        allowed_domains: [
          ...new Set(
            packagedDomains.map((d) => d.path.split("/")[0] ?? d.path),
          ),
        ],
      },
    };

    const nowIso = new Date().toISOString();
    const files: Array<{ path: string; data: Uint8Array; modifiedAt: string }> =
      [];
    const seenPaths = new Set<string>();

    const manifestBytes = new TextEncoder().encode(YAML.stringify(manifestObj));
    files.push({
      path: "feature.yaml",
      data: manifestBytes,
      modifiedAt: nowIso,
    });
    seenPaths.add("feature.yaml");

    // Collect workspace templates & schemas
    for (const d of packagedDomains) {
      const candidateDirs = [
        join(this.workspaceRoot, d.path),
        ...(catEntry ? [join(catEntry.dir, "workspace", d.path)] : []),
      ];
      for (const dir of candidateDirs) {
        if (!existsSync(dir)) continue;
        let entries: Dirent<string>[] = [];
        try {
          entries = readdirSync(dir, {
            encoding: "utf8",
            withFileTypes: true,
          });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const fname = entry.name;
          if (fname.startsWith(".")) continue;
          const isTplOrSchema =
            fname === "project-manifest.toml" ||
            fname.endsWith("-template.md") ||
            fname.endsWith(".schema.json") ||
            fname.endsWith(".openui");
          if (!isTplOrSchema && !options?.include_records) continue;
          const relPath = `workspace/${d.path}/${fname}`;
          if (seenPaths.has(relPath)) continue;
          const absFile = join(dir, fname);
          const stat = statSync(absFile);
          files.push({
            path: relPath,
            data: readFileSync(absFile),
            modifiedAt: stat.mtime.toISOString(),
          });
          seenPaths.add(relPath);
        }
      }
    }

    // Collect skill files
    for (const skId of skillIds) {
      const candidateSkillDirs = [
        join(this.skillsRoot, skId),
        join(this.skillsRoot, ".openlia-disabled", skId),
        ...(catEntry ? [join(catEntry.dir, "skills", skId)] : []),
      ];
      const skillDir = candidateSkillDirs.find((cand) => existsSync(cand));
      if (!skillDir) continue;
      this.walkSkillFiles(skillDir, skillDir, skId, files, seenPaths);
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      metadata: {
        id: featureId,
        name,
        version,
        description,
        author: catEntry?.manifest.author,
        license: catEntry?.manifest.license,
        domains: packagedDomains.map((d) => d.path),
        skills: skillIds,
      },
      files,
    };
  }

  packageZip(options: Partial<FeaturePackageRequest>): {
    filename: string;
    zipBytes: Uint8Array;
  } {
    const captured = this.captureFeatureFiles(options.id, options);
    const entries: ZipArchiveEntry[] = captured.files.map((f) => ({
      path: `${captured.metadata.id}/${f.path}`,
      data: f.data,
      mtime: new Date(f.modifiedAt),
    }));
    return {
      filename: `${captured.metadata.id}-feature.zip`,
      zipBytes: createZipArchive(entries),
    };
  }

  private walkSkillFiles(
    rootDir: string,
    currentDir: string,
    skillId: string,
    out: Array<{ path: string; data: Uint8Array; modifiedAt: string }>,
    seenPaths: Set<string>,
  ): void {
    let entries: Dirent<string>[] = [];
    try {
      entries = readdirSync(currentDir, {
        encoding: "utf8",
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
      const abs = join(currentDir, entry.name);
      let info: Stats;
      try {
        info = lstatSync(abs);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        this.walkSkillFiles(rootDir, abs, skillId, out, seenPaths);
      } else if (info.isFile()) {
        const rel = relative(rootDir, abs).split(sep).join("/");
        const zipRel = `skills/${skillId}/${rel}`;
        if (seenPaths.has(zipRel)) continue;
        seenPaths.add(zipRel);
        out.push({
          path: zipRel,
          data: readFileSync(abs),
          modifiedAt: info.mtime.toISOString(),
        });
      }
    }
  }

  private copyTreeOnce(srcDir: string, dstDir: string): void {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(srcDir, entry.name);
      const dstPath = join(dstDir, entry.name);
      const info = lstatSync(srcPath);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        mkdirSync(dstPath, { recursive: true, mode: 0o700 });
        this.copyTreeOnce(srcPath, dstPath);
      } else if (info.isFile()) {
        if (!existsSync(dstPath)) {
          mkdirSync(dirname(dstPath), { recursive: true, mode: 0o700 });
          writeFileSync(dstPath, readFileSync(srcPath), { mode: 0o600 });
        }
      }
    }
  }
}
