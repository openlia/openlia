import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFormDataFromOpenUIEvent } from "../shared/openui";
import { createWorkspaceHandler } from "./app";

describe("Minions service and HTTP API", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "openlia-minions-test-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("scaffolds Python and TypeScript minions with dashboard.openui, input.openui, input.schema.json, input handler, and dual-triggered main", async () => {
    const handler = createWorkspaceHandler({
      workspaceRoot,
      authRequired: false,
    });

    // 1. Initially empty
    const listRes0 = await handler(new Request("http://localhost/api/minions"));
    expect(listRes0.status).toBe(200);
    const listBody0 = (await listRes0.json()) as any;
    expect(listBody0.minions).toEqual([]);

    // 2. Create a TypeScript minion via POST /api/minions
    const createRes = await handler(
      new Request("http://localhost/api/minions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          id: "gym-tracker",
          name: "Gym Tracker",
          description: "Track workouts and PRs",
          runtime: "typescript",
          heartbeat_schedule: "0 */4 * * *",
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as any;
    expect(createBody.minion.id).toBe("gym-tracker");
    expect(createBody.minion.runtime).toBe("typescript");
    expect(createBody.minion.entrypoint).toBe("main.ts");
    expect(createBody.minion.input_entrypoint).toBe("input.ts");
    expect(createBody.minion.input_schema_file).toBe("input.schema.json");
    expect(createBody.minion.config_file).toBe("config.json");
    expect(createBody.minion.config_schema_file).toBe("config.schema.json");
    expect(createBody.minion.config).toEqual({
      trigger: {
        on_new_entry: true,
        cron: "0 */4 * * *",
      },
    });
    expect(createBody.minion.renderable).toBe(true);
    expect(createBody.minion.primary_ui_file).toBe("dashboard.openui");
    expect(createBody.minion.dashboard_ui_file).toBe("dashboard.openui");
    expect(createBody.minion.input_ui_file).toBe("input.openui");
    expect(createBody.minion.ui_files).toEqual([
      "dashboard.openui",
      "input.openui",
    ]);
    expect(createBody.minion.triggers).toEqual({
      after_entry: true,
      heartbeat_schedule: "0 */4 * * *",
    });

    // 3. Add a nested data file inside minions/gym-tracker/data/2026/october/workouts.csv
    mkdirSync(join(workspaceRoot, "minions/gym-tracker/data/2026/october"), {
      recursive: true,
    });
    writeFileSync(
      join(workspaceRoot, "minions/gym-tracker/data/2026/october/workouts.csv"),
      "date,exercise,weight_kg\n2026-10-30,Squat,120\n",
      "utf-8",
    );

    // 4. Inspect minion detail
    const detailRes = await handler(
      new Request("http://localhost/api/minions/gym-tracker"),
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as any;
    expect(detailBody.minion.data_file_count).toBe(3); // items.json + context.json + workouts.csv
    expect(detailBody.minion.data_files.map((f: any) => f.path)).toContain(
      "minions/gym-tracker/data/2026/october/workouts.csv",
    );

    // 5. Submit structured input via POST /api/minions/gym-tracker/input
    // Should run input.ts AND automatically trigger main.ts --trigger entry
    const inputRes = await handler(
      new Request("http://localhost/api/minions/gym-tracker/input", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          data: {
            item: "Bench Press 5x5",
            category: "strength",
            value: "92.5",
            status: "completed",
            notes: "Clean reps",
          },
        }),
      }),
    );
    expect(inputRes.status).toBe(200);
    const inputBody = (await inputRes.json()) as any;
    expect(inputBody.ok).toBe(true);
    expect(inputBody.exit_code).toBe(0);
    expect(inputBody.steps).toHaveLength(2);
    expect(inputBody.steps[0].step).toBe("input");
    expect(inputBody.steps[0].script).toBe("input.ts");
    expect(inputBody.steps[1].step).toBe("post_entry_main");
    expect(inputBody.steps[1].script).toBe("main.ts");

    const itemsJson = JSON.parse(
      readFileSync(
        join(workspaceRoot, "minions/gym-tracker/data/items.json"),
        "utf-8",
      ),
    );
    expect(itemsJson).toHaveLength(2);
    expect(itemsJson[1].item).toBe("Bench Press 5x5");
    expect(itemsJson[1].value).toBe(92.5);
    expect(itemsJson[1].recommendation).toContain("Bench Press 5x5");

    // Verify dashboard.openui was updated by main.ts (--trigger entry)
    const dashboardContent = readFileSync(
      join(workspaceRoot, "minions/gym-tracker/dashboard.openui"),
      "utf-8",
    );
    expect(dashboardContent).toContain("Bench Press 5x5");
    expect(dashboardContent).toContain("92.5");

    // 6. Reject invalid input against input.schema.json
    const badInputRes = await handler(
      new Request("http://localhost/api/minions/gym-tracker/input", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          data: {
            category: "strength",
          },
        }),
      }),
    );
    expect(badInputRes.status).toBe(400);
    const badInputBody = (await badInputRes.json()) as any;
    expect(badInputBody.error).toBe("invalid_minion_input");

    // 7. Trigger heartbeat via POST /api/minions/gym-tracker/heartbeat
    const hbRes = await handler(
      new Request("http://localhost/api/minions/gym-tracker/heartbeat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(hbRes.status).toBe(200);
    const hbBody = (await hbRes.json()) as any;
    expect(hbBody.ok).toBe(true);
    expect(hbBody.steps).toHaveLength(1);
    expect(hbBody.steps[0].step).toBe("heartbeat");
    expect(hbBody.steps[0].script).toBe("main.ts");

    const contextJson = JSON.parse(
      readFileSync(
        join(workspaceRoot, "minions/gym-tracker/data/context.json"),
        "utf-8",
      ),
    );
    expect(contextJson.last_trigger).toBe("heartbeat");
    expect(contextJson.enrichment.status).toBe("enriched");

    // 8. Verify input.schema.json is readable through /api/workspace/file
    const schemaFileRes = await handler(
      new Request(
        "http://localhost/api/workspace/file?path=minions%2Fgym-tracker%2Finput.schema.json",
      ),
    );
    expect(schemaFileRes.status).toBe(200);

    // 9. Run tests via POST /api/minions/gym-tracker/test
    const testRes = await handler(
      new Request("http://localhost/api/minions/gym-tracker/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(testRes.status).toBe(200);
    const testBody = (await testRes.json()) as any;
    expect(testBody.ok).toBe(true);
    expect(testBody.exit_code).toBe(0);

    // 10. Create a Python minion and test input -> post-entry main, heartbeat, and unittest
    const pyCreateRes = await handler(
      new Request("http://localhost/api/minions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          id: "family-menu",
          name: "Family Menu",
          description: "Weekly meal planner",
          runtime: "python",
        }),
      }),
    );
    expect(pyCreateRes.status).toBe(201);
    const pyCreateBody = (await pyCreateRes.json()) as any;
    expect(pyCreateBody.minion.runtime).toBe("python");
    expect(pyCreateBody.minion.entrypoint).toBe("main.py");
    expect(pyCreateBody.minion.input_entrypoint).toBe("input.py");
    expect(pyCreateBody.minion.dashboard_ui_file).toBe("dashboard.openui");
    expect(pyCreateBody.minion.input_ui_file).toBe("input.openui");

    const pyRunRes = await handler(
      new Request("http://localhost/api/minions/family-menu/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          action: "add",
          input: "Pho Bo for Sunday lunch",
        }),
      }),
    );
    expect(pyRunRes.status).toBe(200);
    const pyRunBody = (await pyRunRes.json()) as any;
    expect(pyRunBody.ok).toBe(true);
    expect(pyRunBody.steps).toHaveLength(2);
    expect(pyRunBody.steps[0].script).toBe("input.py");
    expect(pyRunBody.steps[1].script).toBe("main.py");
    expect(pyRunBody.minion.ui_contents["dashboard.openui"]).toContain(
      "Pho Bo for Sunday lunch",
    );

    const pyHbRes = await handler(
      new Request("http://localhost/api/minions/family-menu/heartbeat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(pyHbRes.status).toBe(200);
    const pyHbBody = (await pyHbRes.json()) as any;
    expect(pyHbBody.ok).toBe(true);
    expect(pyHbBody.stdout).toContain("Heartbeat enrichment complete");

    const pyTestRes = await handler(
      new Request("http://localhost/api/minions/family-menu/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(pyTestRes.status).toBe(200);
    const pyTestBody = (await pyTestRes.json()) as any;
    expect(pyTestBody.ok).toBe(true);

    // 11. Update config.json via PUT /api/minions/family-menu/config with custom agent-defined fields
    // and disable on_new_entry so submitMinionInput skips post_entry_main
    const updateCfgRes = await handler(
      new Request("http://localhost/api/minions/family-menu/config", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          config: {
            trigger: {
              on_new_entry: false,
              cron: "0 7 * * *",
            },
            news_url: "https://example.com/food-news.json",
            calendar_rem_path: "../../calendar/reminders.rem",
          },
        }),
      }),
    );
    expect(updateCfgRes.status).toBe(200);
    const updateCfgBody = (await updateCfgRes.json()) as any;
    expect(updateCfgBody.minion.triggers).toEqual({
      after_entry: false,
      heartbeat_schedule: "0 7 * * *",
    });
    expect(updateCfgBody.minion.config.news_url).toBe(
      "https://example.com/food-news.json",
    );

    // Submitting input when trigger.on_new_entry is false only runs input.py (1 step)
    const inputOnlyRes = await handler(
      new Request("http://localhost/api/minions/family-menu/input", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          data: {
            item: "Bun Cha for Monday dinner",
            category: "dinner",
          },
        }),
      }),
    );
    expect(inputOnlyRes.status).toBe(200);
    const inputOnlyBody = (await inputOnlyRes.json()) as any;
    expect(inputOnlyBody.ok).toBe(true);
    expect(inputOnlyBody.steps).toHaveLength(1);
    expect(inputOnlyBody.steps[0].step).toBe("input");

    // Reject invalid config.json missing required trigger
    const badCfgRes = await handler(
      new Request("http://localhost/api/minions/family-menu/config", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          config: {
            news_url: "https://example.com/missing-trigger",
          },
        }),
      }),
    );
    expect(badCfgRes.status).toBe(400);
    const badCfgBody = (await badCfgRes.json()) as any;
    expect(badCfgBody.error).toBe("invalid_minion_config");

    // 12. Verify testMinion fails when an .openui file has OpenUI schema errors (e.g. Callout tone)
    writeFileSync(
      join(workspaceRoot, "minions/family-menu/input.openui"),
      'Callout(tone: "info", title: "Invalid Callout", description: "Should use variant")\n',
      "utf-8",
    );
    const badUiTestRes = await handler(
      new Request("http://localhost/api/minions/family-menu/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(badUiTestRes.status).toBe(200);
    const badUiTestBody = (await badUiTestRes.json()) as any;
    expect(badUiTestBody.ok).toBe(false);
    expect(badUiTestBody.exit_code).toBe(1);
    expect(badUiTestBody.stderr).toContain("Unknown Callout argument 'tone'");
    expect(badUiTestBody.stderr).toContain(
      "Allowed arguments: variant, title, description",
    );
  });

  test("extractFormDataFromOpenUIEvent unwraps OpenUI Form state", () => {
    const extracted = extractFormDataFromOpenUIEvent({
      formName: "minionInput",
      formState: {
        minionInput: {
          item: { value: "Deadlift 140kg x 5", componentType: "Input" },
          category: { value: "strength", componentType: "Input" },
          value: { value: "140", componentType: "Input" },
        },
      },
    });
    expect(extracted).toEqual({
      item: "Deadlift 140kg x 5",
      category: "strength",
      value: "140",
    });
  });
});
