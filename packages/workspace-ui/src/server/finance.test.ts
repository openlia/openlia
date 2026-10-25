import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FinanceCheckService,
  type FinanceRunner,
  runFinanceProcess,
} from "./finance";
import { createWorkspaceHandler } from "./app";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openlia-finance-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const journal =
  "2026-10-01 Opening\n    assets:bank  100 USD\n    equity:opening\n";
function write(path: string, content = journal) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
const success: FinanceRunner = async (command) => ({
  exitCode: 0,
  output: command.includes("--version")
    ? "hledger 1.52.4"
    : command.includes("--help")
      ? "--no-conf --color"
      : "",
});

describe("finance snapshots", () => {
  test("preserves directive casing, indentation, BOM, and original line endings", async () => {
    write("main.journal", "\uFEFF  INCLUDE child.journal\r\n; keep exact\r\n");
    write("child.journal", journal.replaceAll("\n", "\r\n"));
    const service = new FinanceCheckService(root, {
      runner: async (command, options) => {
        if (command.includes("check")) {
          expect(readFileSync(join(options.cwd, "file0.journal"), "utf8")).toBe(
            "\uFEFF  INCLUDE file1.journal\r\n; keep exact\r\n",
          );
          expect(readFileSync(join(options.cwd, "file1.journal"), "utf8")).toBe(
            journal.replaceAll("\n", "\r\n"),
          );
        }
        return success(command, options);
      },
    });
    expect((await service.check("main.journal")).status).toBe("passed");
  });
  test("bounds deeply nested and exponentially repeated include input", async () => {
    const service = new FinanceCheckService(root, { runner: success });
    for (let index = 0; index < 34; index++)
      write(
        `depth${index}.journal`,
        index === 33 ? journal : `include depth${index + 1}.journal\n`,
      );
    expect((await service.check("depth0.journal")).diagnostics[0]?.code).toBe(
      "snapshot_limit",
    );
    for (let index = 0; index < 8; index++)
      write(
        `repeat${index}.journal`,
        index === 7
          ? journal
          : `include repeat${index + 1}.journal\ninclude repeat${index + 1}.journal\n`,
      );
    expect((await service.check("repeat0.journal")).diagnostics[0]?.code).toBe(
      "snapshot_limit",
    );
  });

  test("limits native check concurrency and releases the slot after completion", async () => {
    write("main.journal");
    let enter: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new FinanceCheckService(root, {
      runner: async (command, options) => {
        if (command.includes("check")) {
          enter?.();
          await pending;
        }
        return success(command, options);
      },
    });
    const first = service.check("main.journal");
    await entered;
    expect((await service.check("main.journal")).diagnostics[0]?.code).toBe(
      "check_busy",
    );
    release?.();
    expect((await first).status).toBe("passed");
    expect((await service.check("main.journal")).status).toBe("passed");
  });
  test("checks a private snapshot, preserves workspace files, and fingerprints all dependencies", async () => {
    write("finance/main.journal", "include nested/year.journal\n");
    write("finance/nested/year.journal");
    let snapshot = "";
    const runner: FinanceRunner = async (command, options) => {
      snapshot = options.cwd;
      expect(options.cwd.startsWith(root)).toBe(false);
      expect(options.env.LEDGER_FILE).toBeUndefined();
      expect(options.env.HOME).not.toBe(process.env.HOME);
      if (command.includes("check")) {
        expect(command).toEqual([
          "hledger",
          "--no-conf",
          "-f",
          "file0.journal",
          "check",
        ]);
        expect(readFileSync(join(options.cwd, "file0.journal"), "utf8")).toBe(
          "include file1.journal\n",
        );
        expect(readFileSync(join(options.cwd, "file1.journal"), "utf8")).toBe(
          journal,
        );
      }
      return success(command, options);
    };
    const service = new FinanceCheckService(root, { runner });
    const result = await service.check("finance/main.journal");
    expect(result.status).toBe("passed");
    expect(result.engine_version).toBe("hledger 1.52.4");
    expect(result.files.map((file) => file.path)).toEqual([
      "finance/main.journal",
      "finance/nested/year.journal",
    ]);
    expect(existsSync(snapshot)).toBe(false);
    expect(readFileSync(join(root, "finance/main.journal"), "utf8")).toBe(
      "include nested/year.journal\n",
    );
    expect(
      readFileSync(join(root, "finance/nested/year.journal"), "utf8"),
    ).toBe(journal);
    expect(
      service.freshness("finance/main.journal", result.fingerprint!).current,
    ).toBe(true);
    write("finance/nested/year.journal", journal + "; changed\n");
    expect(
      service.freshness("finance/main.journal", result.fingerprint!).current,
    ).toBe(false);
  });

  test("maps engine diagnostics to workspace paths and line numbers", async () => {
    write("finance/main.journal", "include year.journal\n");
    write("finance/year.journal");
    const service = new FinanceCheckService(root, {
      runner: async (command, options) =>
        command.includes("check")
          ? {
              exitCode: 1,
              output: `hledger: ${options.cwd}/file1.journal:2: invalid posting`,
            }
          : success(command, options),
    });
    const result = await service.check("finance/main.journal");
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      path: "finance/year.journal",
      line: 2,
    });
    expect(result.diagnostics[0]?.message).toBe(
      "hledger: finance/year.journal:2: invalid posting",
    );
  });

  test("does not pass a newer engine flag to legacy hledger", async () => {
    write("main.journal");
    const service = new FinanceCheckService(root, {
      runner: async (command) => {
        if (command.includes("check"))
          expect(command).not.toContain("--no-conf");
        return {
          exitCode: 0,
          output: command.includes("--version") ? "hledger 1.25" : "",
        };
      },
    });
    expect((await service.check("main.journal")).status).toBe("passed");
  });

  test("blocks unsupported and escaping includes before invoking the engine", async () => {
    let runs = 0;
    const service = new FinanceCheckService(root, {
      runner: async () => {
        runs++;
        return { exitCode: 0, output: "" };
      },
    });
    for (const target of [
      "/etc/passwd",
      "../../secret.journal",
      "*.journal",
      "csv:bank.csv",
      "~/secret.journal",
      "$HOME/*.journal",
    ]) {
      write("finance/main.journal", `include ${target}\n`);
      expect((await service.check("finance/main.journal")).status).toBe(
        "blocked",
      );
    }
    expect(runs).toBe(0);
  });

  test("blocks protected paths, symlink files, and symlink directories", async () => {
    write("outside.journal");
    mkdirSync(join(root, "finance"));
    symlinkSync(
      join(root, "outside.journal"),
      join(root, "finance/link.journal"),
    );
    symlinkSync(join(root, "finance"), join(root, "linked"));
    const service = new FinanceCheckService(root, { runner: success });
    for (const path of [
      "../outside.journal",
      "/etc/secret.journal",
      ".git/secret.journal",
      "finance/link.journal",
      "linked/link.journal",
      "secret.pem",
    ])
      expect((await service.check(path)).status).toBe("blocked");
  });

  test("blocks include cycles, missing files, binary files, and oversized snapshots", async () => {
    const service = new FinanceCheckService(root, {
      runner: success,
      maxSnapshotBytes: 256,
    });
    write("main.journal", "include child.journal\n");
    write("child.journal", "include main.journal\n");
    expect((await service.check("main.journal")).diagnostics[0]?.code).toBe(
      "include_cycle",
    );
    write("main.journal", "include missing.journal\n");
    expect((await service.check("main.journal")).diagnostics[0]?.code).toBe(
      "unreadable_dependency",
    );
    write("main.journal", "\u0000");
    expect((await service.check("main.journal")).status).toBe("blocked");
    write("main.journal", "x".repeat(257));
    expect((await service.check("main.journal")).diagnostics[0]?.code).toBe(
      "snapshot_limit",
    );
  });

  test("detects included-file changes during the engine check", async () => {
    write("main.journal", "include child.journal\n");
    write("child.journal");
    const service = new FinanceCheckService(root, {
      runner: async (command, options) => {
        if (command.includes("check"))
          write("child.journal", journal + "; concurrent save\n");
        return success(command, options);
      },
    });
    const result = await service.check("main.journal");
    expect(result.status).toBe("stale");
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === "snapshot_changed",
      ),
    ).toBe(true);
  });

  test("distinguishes missing engine, timeout, output cap, and infrastructure errors", async () => {
    write("main.journal");
    expect(
      (
        await new FinanceCheckService(root, {
          executable: join(root, "missing-hledger"),
        }).check("main.journal")
      ).status,
    ).toBe("unavailable");
    expect(
      (
        await new FinanceCheckService(root, {
          runner: async () => ({ exitCode: -1, output: "", timedOut: true }),
        }).check("main.journal")
      ).status,
    ).toBe("timed_out");
    expect(
      (
        await new FinanceCheckService(root, {
          runner: async () => ({
            exitCode: -1,
            output: "",
            outputLimited: true,
          }),
        }).check("main.journal")
      ).diagnostics[0]?.code,
    ).toBe("output_limit");
    expect(
      (
        await new FinanceCheckService(root, {
          runner: async () => {
            throw new Error("Crash");
          },
        }).check("main.journal")
      ).status,
    ).toBe("error");
  });

  test("bounds native process runtime and combined diagnostic output", async () => {
    const options = {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 100,
      maxOutputBytes: 1024,
    };
    const timeout = await runFinanceProcess(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      options,
    );
    expect(timeout.timedOut).toBe(true);
    const output = await runFinanceProcess(
      [process.execPath, "-e", 'process.stdout.write("x".repeat(100000))'],
      { ...options, timeoutMs: 2000 },
    );
    expect(output.outputLimited).toBe(true);
    expect(Buffer.byteLength(output.output)).toBeLessThanOrEqual(1024);
  });

  test.skipIf(!Bun.which("hledger"))(
    "real hledger accepts a balanced include tree and rejects unbalanced and malformed journals",
    async () => {
      write("main.journal", "include nested/year.journal\n");
      write("nested/year.journal");
      const service = new FinanceCheckService(root);
      expect((await service.check("main.journal")).status).toBe("passed");
      write(
        "nested/year.journal",
        "2026-10-01 Wrong\n    assets:bank  100 USD\n    equity:opening  -90 USD\n",
      );
      const failed = await service.check("main.journal");
      expect(failed.status).toBe("failed");
      expect(failed.diagnostics[0]?.message).toContain("nested/year.journal");
      write("nested/year.journal", "Not a journal\n");
      expect((await service.check("main.journal")).status).toBe("failed");
    },
  );
});

describe("finance HTTP API", () => {
  test("validates request shape, origin, and authentication before running checks", async () => {
    write("main.journal");
    const handler = createWorkspaceHandler({
      workspaceRoot: root,
      finance: { runner: success },
    });
    const request = (body: unknown, origin?: string) =>
      handler(
        new Request("http://localhost/api/workspace/finance/check", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(origin ? { Origin: origin } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
    expect(
      (await request({ path: "main.journal" }, "https://evil.example")).status,
    ).toBe(403);
    expect(
      (await request({ path: "main.journal", args: ["add"] })).status,
    ).toBe(400);
    expect((await request({ path: 42 })).status).toBe(400);
    const checked = await request({ path: "main.journal" });
    expect(checked.status).toBe(200);
    expect(((await checked.json()) as { status: string }).status).toBe(
      "passed",
    );
    const authenticated = createWorkspaceHandler({
      workspaceRoot: root,
      authRequired: true,
      passwordHash: Bun.password.hashSync("test-password"),
      sessionDatabasePath: join(root, "sessions.sqlite"),
      finance: { runner: success },
    });
    expect(
      (
        await authenticated(
          new Request("http://localhost/api/workspace/finance/check", {
            method: "POST",
            body: JSON.stringify({ path: "main.journal" }),
          }),
        )
      ).status,
    ).toBe(401);
  });

  test("freshness requests never execute hledger and detect deleted dependencies", async () => {
    write("main.journal", "include child.journal\n");
    write("child.journal");
    let runs = 0;
    const handler = createWorkspaceHandler({
      workspaceRoot: root,
      finance: {
        runner: async (command, options) => {
          runs++;
          return success(command, options);
        },
      },
    });
    const post = (path: string, body: unknown) =>
      handler(
        new Request(`http://localhost/api/workspace/finance/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const result = (await (
      await post("check", { path: "main.journal" })
    ).json()) as { fingerprint: string };
    const before = runs;
    expect(
      (
        (await (
          await post("check-status", {
            path: "main.journal",
            fingerprint: result.fingerprint,
          })
        ).json()) as { current: boolean }
      ).current,
    ).toBe(true);
    rmSync(join(root, "child.journal"));
    expect(
      (
        (await (
          await post("check-status", {
            path: "main.journal",
            fingerprint: result.fingerprint,
          })
        ).json()) as { current: boolean }
      ).current,
    ).toBe(false);
    expect(runs).toBe(before);
  });
});
