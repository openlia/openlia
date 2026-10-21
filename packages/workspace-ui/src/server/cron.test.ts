import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronService, CronError } from "./cron";
import { validateCronExpression, getScheduleExpression } from "../shared/cron";

describe("validateCronExpression", () => {
  it("accepts valid standard 5-field cron expressions", () => {
    expect(validateCronExpression("* * * * *").valid).toBe(true);
    expect(validateCronExpression("0 4 * * *").valid).toBe(true);
    expect(validateCronExpression("20 4 * * *").valid).toBe(true);
    expect(validateCronExpression("*/15 * * * *").valid).toBe(true);
    expect(validateCronExpression("0 9 * * 1-5").valid).toBe(true);
    expect(validateCronExpression("0 0 1,15 * *").valid).toBe(true);
    expect(validateCronExpression("59 23 31 12 7").valid).toBe(true);
  });

  it("rejects invalid cron expressions", () => {
    expect(validateCronExpression("").valid).toBe(false);
    expect(validateCronExpression("0 4 * *").valid).toBe(false); // only 4 fields
    expect(validateCronExpression("0 4 * * * *").valid).toBe(false); // 6 fields
    expect(validateCronExpression("60 * * * *").valid).toBe(false); // minute > 59
    expect(validateCronExpression("* 25 * * *").valid).toBe(false); // hour > 23
    expect(validateCronExpression("* * 32 * *").valid).toBe(false); // dom > 31
    expect(validateCronExpression("* * * 13 *").valid).toBe(false); // month > 12
    expect(validateCronExpression("* * * * 8").valid).toBe(false); // dow > 7
    expect(validateCronExpression("abc * * * *").valid).toBe(false); // non-numeric
    expect(validateCronExpression("5-2 * * * *").valid).toBe(false); // inverted range
    expect(validateCronExpression("*/0 * * * *").valid).toBe(false); // step 0
  });

  it("handles getScheduleExpression utility", () => {
    expect(getScheduleExpression("0 4 * * *")).toBe("0 4 * * *");
    expect(getScheduleExpression({ kind: "cron", expr: "0 9 * * *" })).toBe(
      "0 9 * * *",
    );
    expect(
      getScheduleExpression({ kind: "cron", display: "daily at 9am" }),
    ).toBe("daily at 9am");
    expect(getScheduleExpression(undefined)).toBe("");
  });
});

describe("CronService", () => {
  let tempDir: string;
  let cronRoot: string;
  let workspaceRoot: string;
  let service: CronService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openlia-cron-test-"));
    cronRoot = join(tempDir, "cron");
    workspaceRoot = join(tempDir, "workspace");
    service = new CronService({
      cronRoot,
      workspaceRoot,
      backupSchedule: "20 4 * * *",
      backupScheduleEnabled: true,
      workspaceGitSchedule: "0 4 * * *",
      timezone: "Asia/Ho_Chi_Minh",
    });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns empty list when jobs.json does not exist", () => {
    const jobs = service.listJobs();
    expect(jobs).toEqual([]);
  });

  it("creates a new cron job and saves to jobs.json", () => {
    const job = service.createJob({
      name: "Morning Briefing",
      prompt: "Generate daily briefing and summary",
      schedule: "0 9 * * *",
      skills: ["daily-briefing"],
      paused: true,
    });

    expect(job.id).toBeDefined();
    expect(job.name).toBe("Morning Briefing");
    expect(job.prompt).toBe("Generate daily briefing and summary");
    expect(job.state).toBe("paused");
    expect(job.skills).toEqual(["daily-briefing"]);

    const list = service.listJobs();
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(job.id);
  });

  it("reads jobs when file is array format or object format", () => {
    mkdirSync(cronRoot, { recursive: true });
    // Write array format
    writeFileSync(
      join(cronRoot, "jobs.json"),
      JSON.stringify([
        {
          id: "j1",
          name: "Job 1",
          prompt: "p1",
          schedule: "0 0 * * *",
          state: "scheduled",
        },
      ]),
    );
    expect(service.listJobs().length).toBe(1);

    // Write object format { jobs: [...] }
    writeFileSync(
      join(cronRoot, "jobs.json"),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "j2",
            name: "Job 2",
            prompt: "p2",
            schedule: "0 1 * * *",
            state: "scheduled",
          },
        ],
      }),
    );
    const list = service.listJobs();
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe("j2");
  });

  it("updates an existing job", () => {
    const created = service.createJob({
      name: "Initial Name",
      prompt: "Initial prompt",
      schedule: "0 4 * * *",
      paused: false,
    });

    const updated = service.updateJob(created.id, {
      name: "Updated Name",
      schedule: "30 5 * * *",
      state: "paused",
    });

    expect(updated.name).toBe("Updated Name");
    expect(updated.prompt).toBe("Initial prompt");
    expect(updated.state).toBe("paused");
    expect(
      typeof updated.schedule === "object" &&
        updated.schedule.expr === "30 5 * * *",
    ).toBe(true);

    const fetched = service.getJob(created.id);
    expect(fetched?.name).toBe("Updated Name");
  });

  it("toggles job state between scheduled and paused", () => {
    const job = service.createJob({
      name: "Toggle Test",
      prompt: "Prompt",
      schedule: "0 0 * * *",
      paused: false,
    });
    expect(job.state).toBe("scheduled");

    const toggled1 = service.toggleJob(job.id);
    expect(toggled1.state).toBe("paused");

    const toggled2 = service.toggleJob(job.id);
    expect(toggled2.state).toBe("scheduled");

    const explicitlyPaused = service.toggleJob(job.id, true);
    expect(explicitlyPaused.state).toBe("paused");
  });

  it("deletes an existing job", () => {
    const job1 = service.createJob({
      name: "Job 1",
      prompt: "P1",
      schedule: "0 0 * * *",
    });
    const job2 = service.createJob({
      name: "Job 2",
      prompt: "P2",
      schedule: "0 1 * * *",
    });

    expect(service.listJobs().length).toBe(2);
    service.deleteJob(job1.id);

    const remaining = service.listJobs();
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.id).toBe(job2.id);

    expect(() => service.deleteJob(job1.id)).toThrow(CronError);
  });

  it("reads policy from assistant-policy.yaml", () => {
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(
      join(workspaceRoot, "assistant-policy.yaml"),
      `
version: "1.0"
scheduled_work:
  enabled: true
  allowed_actions:
    - generate_reports
    - update_records
  report_destination: inbox/daily-briefing
`,
    );

    const policy = service.getPolicy();
    expect(policy.enabled).toBe(true);
    expect(policy.allowed_actions).toEqual([
      "generate_reports",
      "update_records",
    ]);
    expect(policy.report_destination).toBe("inbox/daily-briefing");
  });

  it("provides comprehensive overview with system schedules", () => {
    service.createJob({
      name: "openlia-workspace-git",
      prompt: "Sync git changes",
      schedule: "0 4 * * *",
    });

    const overview = service.getOverview();
    expect(overview.schema).toBe(1);
    expect(overview.jobs.length).toBe(1);
    expect(overview.system.backup.schedule).toBe("20 4 * * *");
    expect(overview.system.backup.enabled).toBe(true);
    expect(overview.system.workspace_git.schedule).toBe("0 4 * * *");
    expect(overview.system.workspace_git.job_found).toBe(true);
  });
});
