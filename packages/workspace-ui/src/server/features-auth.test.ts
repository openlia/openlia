import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createWorkspaceHandler } from "./app";

describe("feature-management authentication", () => {
  let root: string;
  let workspaceRoot: string;
  let skillsRoot: string;
  let handler: ReturnType<typeof createWorkspaceHandler>;
  const password = "test-only-feature-password";
  const endpoints = ["install", "remove", "package"] as const;

  function snapshot(): Record<string, string> {
    const result: Record<string, string> = {};
    const visit = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) visit(file);
        else
          result[relative(root, file)] = readFileSync(file).toString("base64");
      }
    };
    visit(workspaceRoot);
    visit(skillsRoot);
    return result;
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "openlia-features-auth-"));
    workspaceRoot = join(root, "workspace");
    skillsRoot = join(root, "skills");
    const featuresRoot = join(root, "features");
    mkdirSync(join(workspaceRoot, "travel"), { recursive: true });
    mkdirSync(skillsRoot, { recursive: true });
    mkdirSync(join(featuresRoot, "travel/workspace/travel"), {
      recursive: true,
    });
    writeFileSync(
      join(featuresRoot, "travel/feature.yaml"),
      "schema: 1\nid: travel\nname: Travel\nversion: 1.0.0\ndescription: Travel starter\ndomains: [travel]\n",
    );
    writeFileSync(
      join(featuresRoot, "travel/workspace/travel/trip-template.md"),
      "# Travel template\n",
    );
    writeFileSync(
      join(workspaceRoot, "travel/trip-template.md"),
      "# Existing user template\n",
    );
    handler = createWorkspaceHandler({
      authRequired: true,
      passwordHash: await Bun.password.hash(password, {
        algorithm: "argon2id",
        memoryCost: 32 * 1024,
        timeCost: 2,
      }),
      featuresRoot,
      workspaceRoot,
      skillsRoot,
      sharesDatabasePath: join(root, "shares.sqlite"),
      publicOrigin: "https://workspace.example.test",
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function login(): Promise<string> {
    const response = await handler(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://workspace.example.test",
        },
        body: JSON.stringify({ password }),
      }),
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("login did not set a session cookie");
    return cookie;
  }

  test("blocks anonymous discovery and every feature subroute before dispatch", async () => {
    const before = snapshot();
    for (const path of [
      "/api/features",
      "/api/features?source=catalog",
      "/api/features/",
      "/api/features/future-route",
    ]) {
      const response = await handler(new Request(`http://localhost${path}`));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: "authentication_required",
      });
    }
    expect(snapshot()).toEqual(before);
  });

  test("a forged Origin or session does not authorize feature mutations", async () => {
    const before = snapshot();
    for (const endpoint of endpoints) {
      for (const body of [
        JSON.stringify({ id: "travel", include_records: true }),
        "not-json",
      ]) {
        const response = await handler(
          new Request(`http://localhost/api/features/${endpoint}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "https://workspace.example.test",
              Cookie: "openlia_session=forged",
            },
            body,
          }),
        );
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          error: "authentication_required",
        });
      }
    }
    expect(snapshot()).toEqual(before);
  });

  test("authenticated discovery and same-origin install/package/remove still work", async () => {
    const cookie = await login();
    const headers = {
      Cookie: cookie,
      Origin: "https://workspace.example.test",
      "Content-Type": "application/json",
    };
    const list = await handler(
      new Request("http://localhost/api/features", { headers }),
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      ok: true,
      features: [{ id: "travel" }],
    });
    for (const endpoint of endpoints) {
      const response = await handler(
        new Request(`http://localhost/api/features/${endpoint}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "travel" }),
        }),
      );
      expect(response.status).toBe(200);
      if (endpoint === "package")
        expect(response.headers.get("content-type")).toBe("application/zip");
    }
  });

  test("authenticated sessions still cannot perform cross-origin feature writes", async () => {
    const cookie = await login();
    const before = snapshot();
    for (const endpoint of endpoints) {
      const response = await handler(
        new Request(`http://localhost/api/features/${endpoint}`, {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: "https://attacker.example.test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ id: "travel" }),
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "origin_not_allowed",
      });
    }
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(workspaceRoot, "travel/trip-template.md"))).toBe(
      true,
    );
  });
});
