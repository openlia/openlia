import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { WorkspaceError } from "../workspace";

export type PermissionMode = "allow" | "ask" | "deny";

export interface ConsequentialPermissions {
  version: 1;
  permissions: {
    destructive: {
      delete_records: PermissionMode;
      overwrite_records: PermissionMode;
    };
    external: {
      send_messages: PermissionMode;
      make_purchases: PermissionMode;
      modify_external_accounts: PermissionMode;
      ingest_external_content: PermissionMode;
    };
    scheduled_work: {
      run_briefings: PermissionMode;
      run_audits: PermissionMode;
      run_monitors: PermissionMode;
    };
  };
}

export const DEFAULT_CONSEQUENTIAL_PERMISSIONS: ConsequentialPermissions = {
  version: 1,
  permissions: {
    destructive: {
      delete_records: "ask",
      overwrite_records: "ask",
    },
    external: {
      send_messages: "ask",
      make_purchases: "deny",
      modify_external_accounts: "deny",
      ingest_external_content: "allow",
    },
    scheduled_work: {
      run_briefings: "allow",
      run_audits: "allow",
      run_monitors: "allow",
    },
  },
};

function isPermissionMode(val: unknown): val is PermissionMode {
  return val === "allow" || val === "ask" || val === "deny";
}

export function resolvePermissionsFilePath(
  workspaceRoot: string,
  explicitPath?: string | undefined,
): string {
  if (explicitPath?.trim()) {
    return resolve(explicitPath.trim());
  }
  if (process.env.OPENLIA_PERMISSIONS_FILE?.trim()) {
    return resolve(process.env.OPENLIA_PERMISSIONS_FILE.trim());
  }
  return resolve(workspaceRoot, "..", "permissions.yaml");
}

export function normalizePermissions(raw: unknown): ConsequentialPermissions {
  const result: ConsequentialPermissions = structuredClone(
    DEFAULT_CONSEQUENTIAL_PERMISSIONS,
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return result;
  }
  const obj = raw as Record<string, unknown>;
  const perms =
    obj.permissions &&
    typeof obj.permissions === "object" &&
    !Array.isArray(obj.permissions)
      ? (obj.permissions as Record<string, unknown>)
      : {};

  const destructive =
    perms.destructive &&
    typeof perms.destructive === "object" &&
    !Array.isArray(perms.destructive)
      ? (perms.destructive as Record<string, unknown>)
      : {};
  if (isPermissionMode(destructive.delete_records)) {
    result.permissions.destructive.delete_records = destructive.delete_records;
  }
  if (isPermissionMode(destructive.overwrite_records)) {
    result.permissions.destructive.overwrite_records =
      destructive.overwrite_records;
  }

  const external =
    perms.external &&
    typeof perms.external === "object" &&
    !Array.isArray(perms.external)
      ? (perms.external as Record<string, unknown>)
      : {};
  if (isPermissionMode(external.send_messages)) {
    result.permissions.external.send_messages = external.send_messages;
  }
  if (isPermissionMode(external.make_purchases)) {
    result.permissions.external.make_purchases = external.make_purchases;
  }
  if (isPermissionMode(external.modify_external_accounts)) {
    result.permissions.external.modify_external_accounts =
      external.modify_external_accounts;
  }
  if (isPermissionMode(external.ingest_external_content)) {
    result.permissions.external.ingest_external_content =
      external.ingest_external_content;
  }

  const scheduled =
    perms.scheduled_work &&
    typeof perms.scheduled_work === "object" &&
    !Array.isArray(perms.scheduled_work)
      ? (perms.scheduled_work as Record<string, unknown>)
      : {};
  if (isPermissionMode(scheduled.run_briefings)) {
    result.permissions.scheduled_work.run_briefings = scheduled.run_briefings;
  }
  if (isPermissionMode(scheduled.run_audits)) {
    result.permissions.scheduled_work.run_audits = scheduled.run_audits;
  }
  if (isPermissionMode(scheduled.run_monitors)) {
    result.permissions.scheduled_work.run_monitors = scheduled.run_monitors;
  }

  return result;
}

export function validatePermissionsInput(
  raw: unknown,
): ConsequentialPermissions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkspaceError(
      "permissions payload must be an object",
      400,
      "invalid_permissions",
    );
  }
  const obj = raw as Record<string, unknown>;
  const perms =
    obj.permissions &&
    typeof obj.permissions === "object" &&
    !Array.isArray(obj.permissions)
      ? (obj.permissions as Record<string, unknown>)
      : obj;

  const checkGroup = (
    groupName: string,
    keys: string[],
    groupVal: unknown,
  ): void => {
    if (groupVal === undefined) return;
    if (!groupVal || typeof groupVal !== "object" || Array.isArray(groupVal)) {
      throw new WorkspaceError(
        `permissions.${groupName} must be an object`,
        400,
        "invalid_permissions",
      );
    }
    for (const [k, v] of Object.entries(groupVal as Record<string, unknown>)) {
      if (!keys.includes(k)) {
        throw new WorkspaceError(
          `unrecognized permission key permissions.${groupName}.${k}`,
          400,
          "invalid_permissions",
        );
      }
      if (!isPermissionMode(v)) {
        throw new WorkspaceError(
          `permissions.${groupName}.${k} must be 'allow', 'ask', or 'deny'`,
          400,
          "invalid_permissions",
        );
      }
    }
  };

  checkGroup(
    "destructive",
    ["delete_records", "overwrite_records"],
    perms.destructive,
  );
  checkGroup(
    "external",
    [
      "send_messages",
      "make_purchases",
      "modify_external_accounts",
      "ingest_external_content",
    ],
    perms.external,
  );
  checkGroup(
    "scheduled_work",
    ["run_briefings", "run_audits", "run_monitors"],
    perms.scheduled_work,
  );

  return normalizePermissions({ version: 1, permissions: perms });
}

export function loadConsequentialPermissions(
  workspaceRoot: string,
  explicitPath?: string | undefined,
): ConsequentialPermissions {
  const filePath = resolvePermissionsFilePath(workspaceRoot, explicitPath);
  if (!existsSync(filePath)) {
    return structuredClone(DEFAULT_CONSEQUENTIAL_PERMISSIONS);
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = YAML.parse(raw);
    return normalizePermissions(parsed);
  } catch {
    return structuredClone(DEFAULT_CONSEQUENTIAL_PERMISSIONS);
  }
}

export function saveConsequentialPermissions(
  workspaceRoot: string,
  input: unknown,
  explicitPath?: string | undefined,
): ConsequentialPermissions {
  const validated = validatePermissionsInput(input);
  const filePath = resolvePermissionsFilePath(workspaceRoot, explicitPath);
  const parentDir = dirname(filePath);
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });

  const serialized = YAML.stringify(validated);
  const tempPath = join(
    parentDir,
    `.permissions.yaml.tmp-${randomUUID().slice(0, 8)}`,
  );

  try {
    writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {}
    }
    // Single-file bind mount fallback where renameSync across mount boundary returns EXDEV/EBUSY
    writeFileSync(filePath, serialized, { encoding: "utf8", mode: 0o600 });
  }

  return validated;
}
