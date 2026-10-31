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
import { createWorkspaceHandler } from "./app";

describe("Minions service and HTTP API", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "openlia-minions-test-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("scaffolds Python and TypeScript minions, supports nested data/ files, runs entrypoint and tests", async () => {
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
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as any;
    expect(createBody.minion.id).toBe("gym-tracker");
    expect(createBody.minion.runtime).toBe("typescript");
    expect(createBody.minion.entrypoint).toBe("main.ts");
    expect(createBody.minion.renderable).toBe(true);
    expect(createBody.minion.primary_ui_file).toBe("ui.openui");

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
    expect(detailBody.minion.data_file_count).toBe(2);
    expect(detailBody.minion.data_files.map((f: any) => f.path)).toContain(
      "minions/gym-tracker/data/2026/october/workouts.csv",
    );

    // 5. Run quick-input action via POST /api/minions/gym-tracker/run
    const runRes = await handler(
      new Request("http://localhost/api/minions/gym-tracker/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          action: "add",
          input: "Bench Press 90kg x 5",
        }),
      }),
    );
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as any;
    expect(runBody.ok).toBe(true);
    expect(runBody.exit_code).toBe(0);

    const itemsJson = JSON.parse(
      readFileSync(
        join(workspaceRoot, "minions/gym-tracker/data/items.json"),
        "utf-8",
      ),
    );
    expect(itemsJson).toHaveLength(2);
    expect(itemsJson[1].item).toBe("Bench Press 90kg x 5");

    // Verify ui.openui was updated by main.ts
    const uiContent = readFileSync(
      join(workspaceRoot, "minions/gym-tracker/ui.openui"),
      "utf-8",
    );
    expect(uiContent).toContain("Bench Press 90kg x 5");

    // 6. Run tests via POST /api/minions/gym-tracker/test
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

    // 7. Create a Python minion and run quick-input + unittest
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
  });
});
