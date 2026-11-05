/** Code-only Minion distribution. Keep in parity with operator/minion_distribution.go. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { WorkspaceError } from "./workspace";

export const MINION_PACKAGE_FILE = "minion.package.json";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const RESERVED = new Set([
  "config.json",
  "data",
  "state",
  "cache",
  "caches",
  "logs",
  "uploads",
  "tmp",
  "temp",
  "node_modules",
  "__pycache__",
  "venv",
  "env",
  "dist",
  "build",
  "coverage",
]);

function invalid(message: string): never {
  throw new WorkspaceError(message, 400, "invalid_minion_package");
}

export function minionDomainId(path: string): string | undefined {
  const parts = path.split("/");
  if (parts[0] !== "minions") return undefined;
  if (parts.length !== 2 || !/^[a-z0-9][a-z0-9-]*$/.test(parts[1] ?? "")) {
    invalid(`select an exact minions/<slug> domain, not ${path}`);
  }
  return parts[1];
}

export function portableMinionFile(path: string): boolean {
  if (!path || /[\\:\0]/.test(path) || isAbsolute(path)) return false;
  return path.split("/").every((part) => {
    const lower = part.toLowerCase();
    return (
      part.length > 0 &&
      !part.startsWith(".") &&
      !RESERVED.has(lower) &&
      !/\.(pyc|log|pem|key)$/.test(lower) &&
      !/(credential|secret|token|id_rsa|id_ed25519)/.test(lower)
    );
  });
}

export function safeMinionPath(root: string, path: string): string {
  if (
    isAbsolute(path) ||
    /[\\:\0]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    invalid(`unsafe Minion path ${path}`);
  }
  const base = resolve(root);
  const full = resolve(base, path);
  if (!full.startsWith(`${base}${sep}`)) invalid(`unsafe Minion path ${path}`);
  for (let current = full; ; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink())
        invalid(`symlink in Minion path ${current}`);
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
    }
    if (current === base) break;
  }
  return full;
}

function readPortableFile(root: string, path: string): Uint8Array {
  const file = safeMinionPath(root, path);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
    invalid(`invalid or oversized Minion file ${path}`);
  const data = readFileSync(file);
  const text = data.toString("utf8");
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b|\bglpat-[A-Za-z0-9\-=_]{20,}\b|\bsk-[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b/i.test(
      text,
    )
  ) {
    invalid(
      `Minion package file ${path} rejected: credential pattern detected`,
    );
  }
  return data;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function schemaDefault(schema: Record<string, unknown>): unknown {
  if ("default" in schema) return structuredClone(schema.default);
  if (schema.type !== "object") return undefined;
  const result: Record<string, unknown> = {};
  if (object(schema.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!object(child)) continue;
      const value = schemaDefault(child);
      if (value !== undefined)
        Object.defineProperty(result, key, {
          value,
          enumerable: true,
          writable: true,
        });
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export function compileMinionConfig(schema: unknown) {
  if (
    !object(schema) ||
    schema.type !== "object" ||
    !Array.isArray(schema.required) ||
    !schema.required.includes("trigger")
  ) {
    invalid(
      "config.schema.json must declare an object schema and require trigger",
    );
  }
  if (
    "$schema" in schema &&
    schema.$schema !== "https://json-schema.org/draft/2020-12/schema"
  )
    invalid("config.schema.json must use Draft 2020-12");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  // compile is synchronous: AJV does not fetch external refs or run app code.
  const validateSchema = ajv.compile(schema);
  const validate = (value: unknown) => {
    if (!object(value) || !validateSchema(value)) return false;
    const trigger = value.trigger;
    if (typeof trigger === "string")
      return ["entry", "cron", "both"].includes(trigger);
    return (
      object(trigger) &&
      Object.keys(trigger).length > 0 &&
      Object.entries(trigger).every(([key, item]) =>
        key === "on_new_entry"
          ? typeof item === "boolean"
          : key === "cron" &&
            typeof item === "string" &&
            item.trim().length > 0,
      )
    );
  };
  const raw = schemaDefault(schema);
  const defaults = object(raw) ? raw : {};
  defaults.trigger = { on_new_entry: false };
  if ("data_views" in defaults)
    defaults.data_views = { briefing: [], scopes: {} };
  return { validate, defaults: validate(defaults) ? defaults : undefined };
}

export function readMinionPackage(dir: string, id: string, strict = false) {
  const raw: unknown = JSON.parse(
    new TextDecoder().decode(readPortableFile(dir, MINION_PACKAGE_FILE)),
  );
  if (
    !object(raw) ||
    raw.schema !== 1 ||
    Object.keys(raw).some((key) => key !== "schema" && key !== "files") ||
    !Array.isArray(raw.files) ||
    raw.files.length === 0
  ) {
    invalid(
      `Minion ${id} needs a reviewed ${MINION_PACKAGE_FILE} with schema: 1 and explicit files`,
    );
  }
  const seen = new Set([MINION_PACKAGE_FILE]);
  const seenFold = new Set([MINION_PACKAGE_FILE]);
  for (const path of raw.files) {
    if (
      typeof path !== "string" ||
      !portableMinionFile(path) ||
      seenFold.has(path.toLowerCase())
    )
      invalid(`unsafe or duplicate Minion distribution file ${path}`);
    readPortableFile(dir, path);
    seen.add(path);
    seenFold.add(path.toLowerCase());
  }
  for (const name of [
    "README.md",
    "dashboard.openui",
    "input.openui",
    "input.schema.json",
    "config.schema.json",
  ]) {
    if (!seen.has(name))
      invalid(`Minion distribution missing required file ${name}`);
  }
  if (
    seen.has("main.py") === seen.has("main.ts") ||
    seen.has("input.py") === seen.has("input.ts") ||
    seen.has("main.py") !== seen.has("input.py")
  ) {
    invalid(
      "Minion distribution requires exactly one runtime and its input entrypoint",
    );
  }
  if (![...seen].some((path) => path.startsWith("tests/")))
    invalid("Minion distribution must include tests/");
  const config = compileMinionConfig(
    JSON.parse(
      new TextDecoder().decode(readPortableFile(dir, "config.schema.json")),
    ),
  );
  if (strict) {
    const visit = (folder: string, prefix = "") => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = `${prefix}${entry.name}`;
        if (
          entry.isSymbolicLink() ||
          !portableMinionFile(path) ||
          (!entry.isDirectory() && !seen.has(path))
        ) {
          invalid(
            `Minion package contains undeclared or local-only path ${path}`,
          );
        }
        if (entry.isDirectory()) visit(join(folder, entry.name), `${path}/`);
      }
    };
    visit(dir);
  }
  return { id, dir, files: [...seen].sort(), ...config };
}

export type MinionPackage = ReturnType<typeof readMinionPackage>;

export function featureMinionPackages(
  workspace: string,
  domains: Array<{ path: string }>,
): MinionPackage[] {
  const selected = new Set(
    domains
      .map((d) => minionDomainId(d.path))
      .filter((id): id is string => !!id),
  );
  const root = safeMinionPath(workspace, "minions");
  if (!existsSync(root)) {
    if (selected.size > 0) invalid("feature declares a missing Minion package");
    return [];
  }
  const packages: MinionPackage[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !selected.has(entry.name)
    ) {
      invalid(
        `feature must declare each Minion as an exact domain: minions/${entry.name}`,
      );
    }
    packages.push(readMinionPackage(join(root, entry.name), entry.name, true));
    selected.delete(entry.name);
  }
  if (selected.size > 0) invalid("feature declares a missing Minion package");
  return packages;
}

export function initializeFeatureMinions(
  workspace: string,
  packages: MinionPackage[],
) {
  return packages.map((pkg) => {
    const path = safeMinionPath(workspace, `minions/${pkg.id}/config.json`);
    if (pkg.defaults) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        writeFileSync(path, `${JSON.stringify(pkg.defaults, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
      }
    }
    let configured = false;
    try {
      configured = !!pkg.validate(JSON.parse(readFileSync(path, "utf8")));
    } catch {}
    return { id: pkg.id, configuration_required: !configured };
  });
}

export function captureMinionPackage(dir: string, id: string, domain: string) {
  const pkg = readMinionPackage(dir, id);
  return pkg.files.map((path) => ({
    path: `workspace/${domain}/${path}`,
    data: readPortableFile(dir, path),
    modifiedAt: lstatSync(safeMinionPath(dir, path)).mtime.toISOString(),
  }));
}
