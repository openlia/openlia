export interface HermesCronSchedule {
  kind?: "cron" | "interval" | "at" | string | undefined;
  expr?: string | undefined;
  display?: string | undefined;
  tz?: string | undefined;
}

export interface HermesCronJob {
  id: string;
  name: string;
  prompt: string;
  schedule: HermesCronSchedule | string;
  skills?: string[] | undefined;
  deliver?: string | undefined;
  state: "scheduled" | "paused";
  created_at?: string | undefined;
  updated_at?: string | undefined;
}

export interface SystemBackupSchedule {
  schedule: string;
  enabled: boolean;
  timezone: string;
}

export interface SystemWorkspaceGitSchedule {
  schedule: string;
  job_found: boolean;
}

export interface SystemSchedules {
  backup: SystemBackupSchedule;
  workspace_git: SystemWorkspaceGitSchedule;
}

export interface ScheduledWorkPolicy {
  enabled: boolean;
  allowed_actions: string[];
  report_destination?: string | undefined;
}

export interface CronOverviewResponse {
  schema: 1;
  jobs: HermesCronJob[];
  system: SystemSchedules;
  policy: ScheduledWorkPolicy;
}

export interface CreateCronJobInput {
  name: string;
  prompt: string;
  schedule: string;
  skills?: string[] | undefined;
  paused?: boolean | undefined;
}

export interface UpdateCronJobInput {
  name?: string | undefined;
  prompt?: string | undefined;
  schedule?: string | undefined;
  skills?: string[] | undefined;
  state?: "scheduled" | "paused" | undefined;
}

/**
 * Validates a standard 5-field cron expression (minute, hour, day-of-month, month, day-of-week).
 */
export function validateCronExpression(expression: string): {
  valid: boolean;
  error?: string | undefined;
} {
  const trimmed = expression.trim();
  if (!trimmed) {
    return { valid: false, error: "Cron expression cannot be empty" };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return {
      valid: false,
      error: `Expected 5 cron fields (minute hour dom month dow), got ${parts.length}`,
    };
  }

  const fieldLimits = [
    { name: "minute", min: 0, max: 59 },
    { name: "hour", min: 0, max: 23 },
    { name: "day of month", min: 1, max: 31 },
    { name: "month", min: 1, max: 12 },
    { name: "day of week", min: 0, max: 7 },
  ];

  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    const limit = fieldLimits[i];
    if (!field || !limit) continue;

    // Check each sub-item separated by commas
    const subItems = field.split(",");
    for (const sub of subItems) {
      if (!sub) {
        return {
          valid: false,
          error: `Invalid empty entry in ${limit.name} field`,
        };
      }
      if (sub === "*") continue;

      // Handle step e.g. */5 or 1-10/2
      let rangePart = sub;
      if (sub.includes("/")) {
        const split = sub.split("/");
        const base = split[0];
        const step = split[1];
        if (!step || !base || !/^\d+$/.test(step) || Number(step) <= 0) {
          return {
            valid: false,
            error: `Invalid step value in ${limit.name}: "${sub}"`,
          };
        }
        rangePart = base;
        if (rangePart === "*") continue;
      }

      // Handle range e.g. 1-5
      if (rangePart.includes("-")) {
        const split = rangePart.split("-");
        const start = split[0];
        const end = split[1];
        if (!start || !end || !/^\d+$/.test(start) || !/^\d+$/.test(end)) {
          return {
            valid: false,
            error: `Invalid range in ${limit.name}: "${sub}"`,
          };
        }
        const s = Number(start);
        const e = Number(end);
        if (
          s < limit.min ||
          s > limit.max ||
          e < limit.min ||
          e > limit.max ||
          s > e
        ) {
          return {
            valid: false,
            error: `Range out of bounds in ${limit.name}: "${sub}"`,
          };
        }
      } else {
        if (!/^\d+$/.test(rangePart)) {
          return {
            valid: false,
            error: `Invalid token in ${limit.name}: "${sub}"`,
          };
        }
        const val = Number(rangePart);
        if (val < limit.min || val > limit.max) {
          return {
            valid: false,
            error: `Value out of bounds in ${limit.name}: "${sub}" (${limit.min}-${limit.max})`,
          };
        }
      }
    }
  }

  return { valid: true };
}

/**
 * Normalizes schedule representation to a string for display and editing.
 */
export function getScheduleExpression(
  schedule: HermesCronSchedule | string | undefined,
): string {
  if (!schedule) return "";
  if (typeof schedule === "string") return schedule;
  return schedule.expr || schedule.display || "";
}
