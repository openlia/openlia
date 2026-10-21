import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import type {
  CreateCronJobInput,
  CronOverviewResponse,
  HermesCronJob,
  ScheduledWorkPolicy,
  SystemSchedules,
  UpdateCronJobInput,
} from "../shared/cron";
import { validateCronExpression } from "../shared/cron";

export interface CronServiceOptions {
  cronRoot: string;
  workspaceRoot: string;
  backupSchedule?: string | undefined;
  backupScheduleEnabled?: boolean | undefined;
  workspaceGitSchedule?: string | undefined;
  timezone?: string | undefined;
}

export class CronError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly code: string = "cron_error",
  ) {
    super(message);
    this.name = "CronError";
  }
}

interface JobsContainer {
  format: "array" | "object";
  jobs: HermesCronJob[];
  extra?: Record<string, unknown> | undefined;
}

export class CronService {
  readonly cronRoot: string;
  readonly workspaceRoot: string;
  readonly backupSchedule: string;
  readonly backupScheduleEnabled: boolean;
  readonly workspaceGitSchedule: string;
  readonly timezone: string;

  constructor(options: CronServiceOptions) {
    this.cronRoot = resolve(options.cronRoot);
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.backupSchedule = options.backupSchedule || "20 4 * * *";
    this.backupScheduleEnabled = options.backupScheduleEnabled ?? true;
    this.workspaceGitSchedule = options.workspaceGitSchedule || "0 4 * * *";
    this.timezone = options.timezone || "Asia/Ho_Chi_Minh";
  }

  private get jobsFilePath(): string {
    return join(this.cronRoot, "jobs.json");
  }

  private readJobsContainer(): JobsContainer {
    const path = this.jobsFilePath;
    if (!existsSync(path)) {
      return { format: "array", jobs: [] };
    }
    try {
      const content = readFileSync(path, "utf8").trim();
      if (!content) {
        return { format: "array", jobs: [] };
      }
      const parsed: unknown = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return { format: "array", jobs: parsed as HermesCronJob[] };
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as { jobs?: unknown; [k: string]: unknown };
        if (Array.isArray(obj.jobs)) {
          const { jobs, ...extra } = obj;
          return { format: "object", jobs: jobs as HermesCronJob[], extra };
        }
      }
      return { format: "array", jobs: [] };
    } catch (err) {
      throw new CronError(
        `Failed to parse cron jobs file: ${err instanceof Error ? err.message : String(err)}`,
        500,
        "jobs_file_corrupt",
      );
    }
  }

  private writeJobsContainer(container: JobsContainer): void {
    if (!existsSync(this.cronRoot)) {
      mkdirSync(this.cronRoot, { recursive: true });
    }
    const targetPath = this.jobsFilePath;
    const tempPath = join(
      this.cronRoot,
      `.jobs.json.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    );

    let outputData: unknown;
    if (container.format === "object") {
      outputData = {
        ...(container.extra || {}),
        jobs: container.jobs,
      };
    } else {
      outputData = container.jobs;
    }

    const payload = `${JSON.stringify(outputData, null, 2)}\n`;
    try {
      writeFileSync(tempPath, payload, { mode: 0o600 });
      renameSync(tempPath, targetPath);
    } catch (err) {
      try {
        unlinkSync(tempPath);
      } catch {
        // ignore cleanup error
      }
      throw new CronError(
        `Failed to write cron jobs file: ${err instanceof Error ? err.message : String(err)}`,
        500,
        "jobs_write_failed",
      );
    }
  }

  listJobs(): HermesCronJob[] {
    return this.readJobsContainer().jobs;
  }

  getJob(id: string): HermesCronJob | null {
    const jobs = this.listJobs();
    return jobs.find((j) => j.id === id) || null;
  }

  createJob(input: CreateCronJobInput): HermesCronJob {
    const name = input.name?.trim();
    if (!name) {
      throw new CronError("Job name is required", 400, "missing_name");
    }
    const prompt = input.prompt?.trim();
    if (!prompt) {
      throw new CronError("Job prompt is required", 400, "missing_prompt");
    }
    const scheduleStr = input.schedule?.trim();
    if (!scheduleStr) {
      throw new CronError(
        "Schedule expression is required",
        400,
        "missing_schedule",
      );
    }

    const valResult = validateCronExpression(scheduleStr);
    if (!valResult.valid) {
      throw new CronError(
        valResult.error || "Invalid cron expression",
        400,
        "invalid_cron",
      );
    }

    const container = this.readJobsContainer();
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date().toISOString();

    const newJob: HermesCronJob = {
      id,
      name,
      prompt,
      schedule: {
        kind: "cron",
        expr: scheduleStr,
        display: scheduleStr,
      },
      skills: Array.isArray(input.skills) ? input.skills.filter(Boolean) : [],
      state: input.paused ? "paused" : "scheduled",
      created_at: now,
      updated_at: now,
    };

    container.jobs.push(newJob);
    this.writeJobsContainer(container);
    return newJob;
  }

  updateJob(id: string, input: UpdateCronJobInput): HermesCronJob {
    const container = this.readJobsContainer();
    const index = container.jobs.findIndex((j) => j.id === id);
    if (index === -1) {
      throw new CronError(
        `Job with id "${id}" not found`,
        404,
        "job_not_found",
      );
    }

    const existing = container.jobs[index];
    if (!existing) {
      throw new CronError(
        `Job with id "${id}" not found`,
        404,
        "job_not_found",
      );
    }

    const updated: HermesCronJob = {
      id: existing.id,
      name: existing.name,
      prompt: existing.prompt,
      schedule: existing.schedule,
      skills: existing.skills,
      deliver: existing.deliver,
      state: existing.state,
      created_at: existing.created_at,
      updated_at: existing.updated_at,
    };

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name)
        throw new CronError("Job name cannot be empty", 400, "empty_name");
      updated.name = name;
    }

    if (input.prompt !== undefined) {
      const prompt = input.prompt.trim();
      if (!prompt)
        throw new CronError("Job prompt cannot be empty", 400, "empty_prompt");
      updated.prompt = prompt;
    }

    if (input.schedule !== undefined) {
      const scheduleStr = input.schedule.trim();
      if (!scheduleStr)
        throw new CronError(
          "Schedule expression cannot be empty",
          400,
          "empty_schedule",
        );
      const valResult = validateCronExpression(scheduleStr);
      if (!valResult.valid) {
        throw new CronError(
          valResult.error || "Invalid cron expression",
          400,
          "invalid_cron",
        );
      }
      if (typeof existing.schedule === "object" && existing.schedule !== null) {
        updated.schedule = {
          ...existing.schedule,
          expr: scheduleStr,
          display: scheduleStr,
        };
      } else {
        updated.schedule = scheduleStr;
      }
    }

    if (input.skills !== undefined) {
      updated.skills = Array.isArray(input.skills)
        ? input.skills.filter(Boolean)
        : [];
    }

    if (input.state !== undefined) {
      if (input.state !== "scheduled" && input.state !== "paused") {
        throw new CronError(
          "State must be either 'scheduled' or 'paused'",
          400,
          "invalid_state",
        );
      }
      updated.state = input.state;
    }

    updated.updated_at = new Date().toISOString();
    container.jobs[index] = updated;
    this.writeJobsContainer(container);
    return updated;
  }

  toggleJob(id: string, paused?: boolean): HermesCronJob {
    const container = this.readJobsContainer();
    const index = container.jobs.findIndex((j) => j.id === id);
    if (index === -1) {
      throw new CronError(
        `Job with id "${id}" not found`,
        404,
        "job_not_found",
      );
    }

    const job = container.jobs[index];
    if (!job) {
      throw new CronError(
        `Job with id "${id}" not found`,
        404,
        "job_not_found",
      );
    }

    const targetState =
      paused !== undefined
        ? paused
          ? "paused"
          : "scheduled"
        : job.state === "paused"
          ? "scheduled"
          : "paused";

    job.state = targetState;
    job.updated_at = new Date().toISOString();
    container.jobs[index] = job;
    this.writeJobsContainer(container);
    return job;
  }

  deleteJob(id: string): void {
    const container = this.readJobsContainer();
    const index = container.jobs.findIndex((j) => j.id === id);
    if (index === -1) {
      throw new CronError(
        `Job with id "${id}" not found`,
        404,
        "job_not_found",
      );
    }
    container.jobs.splice(index, 1);
    this.writeJobsContainer(container);
  }

  getPolicy(): ScheduledWorkPolicy {
    const policyPath = join(this.workspaceRoot, "assistant-policy.yaml");
    if (!existsSync(policyPath)) {
      return {
        enabled: false,
        allowed_actions: [],
      };
    }
    try {
      const raw = readFileSync(policyPath, "utf8");
      const parsed: unknown = YAML.parse(raw);
      if (parsed && typeof parsed === "object") {
        const obj = parsed as { scheduled_work?: unknown };
        const scheduledWork = obj.scheduled_work;
        if (scheduledWork && typeof scheduledWork === "object") {
          const sw = scheduledWork as {
            enabled?: unknown;
            allowed_actions?: unknown;
            report_destination?: unknown;
          };
          const destination = sw.report_destination
            ? String(sw.report_destination)
            : undefined;
          return {
            enabled: Boolean(sw.enabled),
            allowed_actions: Array.isArray(sw.allowed_actions)
              ? sw.allowed_actions.map(String)
              : [],
            ...(destination ? { report_destination: destination } : {}),
          };
        }
      }
    } catch {
      // Return conservative disabled policy if corrupted
    }
    return {
      enabled: false,
      allowed_actions: [],
    };
  }

  getSystemSchedules(jobs: HermesCronJob[]): SystemSchedules {
    const gitJobFound = jobs.some(
      (j) =>
        j.name === "openlia-workspace-git" || j.id === "openlia-workspace-git",
    );
    return {
      backup: {
        schedule: this.backupSchedule,
        enabled: this.backupScheduleEnabled,
        timezone: this.timezone,
      },
      workspace_git: {
        schedule: this.workspaceGitSchedule,
        job_found: gitJobFound,
      },
    };
  }

  getOverview(): CronOverviewResponse {
    const jobs = this.listJobs();
    const system = this.getSystemSchedules(jobs);
    const policy = this.getPolicy();
    return {
      schema: 1,
      jobs,
      system,
      policy,
    };
  }
}
