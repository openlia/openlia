import { readFileSync } from "node:fs";
import { WorkspaceError } from "./workspace";

const minimumPattern = /^>=(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const runtimePattern =
  /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function runtimeMeetsMinimum(
  version: string,
  requirement: string,
): boolean {
  const minimum = minimumPattern.exec(requirement);
  if (!minimum || minimum[0] !== requirement) {
    throw new WorkspaceError(
      'requires.openlia must be a minimum stable version such as ">=1.2.3"',
      400,
      "invalid_template_compatibility",
    );
  }
  const actual = runtimePattern.exec(version);
  if (
    !actual ||
    actual[0] !== version ||
    actual[4]
      ?.slice(1)
      .split(".")
      .some((part) => /^0[0-9]+$/.test(part))
  ) {
    throw new WorkspaceError(
      "Deployed Workspace UI release identity has an invalid runtime version",
      409,
      "runtime_identity_unavailable",
    );
  }
  for (let i = 1; i <= 3; i++) {
    const left = actual[i] ?? "";
    const right = minimum[i] ?? "";
    if (left.length !== right.length) return left.length > right.length;
    if (left !== right) return left > right;
  }
  return !actual[4];
}

export function readTemplatesRuntimeVersion(
  path = "/opt/openlia/runtime-release.json",
): string {
  try {
    const identity = JSON.parse(readFileSync(path, "utf8"));
    if (identity?.schema === 1 && typeof identity.openlia === "string") {
      return identity.openlia;
    }
  } catch {}
  throw new WorkspaceError(
    "Cannot verify deployed Workspace UI release identity; deploy a compatible runtime before retrying. No installed workspace files were changed.",
    409,
    "runtime_identity_unavailable",
  );
}

export function checkTemplateRequirements(
  requires: unknown,
  label: string,
  version: () => string,
): void {
  if (requires === undefined || requires === null) return;
  if (typeof requires !== "object" || Array.isArray(requires)) {
    throw new WorkspaceError(
      `${label}: requires must be a mapping`,
      400,
      "invalid_template_compatibility",
    );
  }
  if (!("openlia" in requires)) return;
  const requirement = requires.openlia;
  if (
    typeof requirement !== "string" ||
    minimumPattern.exec(requirement)?.[0] !== requirement
  ) {
    throw new WorkspaceError(
      `${label}: requires.openlia must be a minimum stable version such as ">=1.2.3"`,
      400,
      "invalid_template_compatibility",
    );
  }
  const actual = version();
  if (!runtimeMeetsMinimum(actual, requirement)) {
    throw new WorkspaceError(
      `${label} requires OpenLia ${requirement}; detected deployed runtime ${actual}. Upgrade the deployment before retrying. No installed workspace files were changed.`,
      409,
      "template_incompatible",
    );
  }
}
