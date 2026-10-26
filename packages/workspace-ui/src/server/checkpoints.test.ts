import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import type { CheckpointProposal } from "../shared/checkpoints";
import { createWorkspaceHandler } from "./app";

let root: string;
let handler: ReturnType<typeof createWorkspaceHandler>;
function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args]);
  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout).trim();
}
function request(path: string, init?: RequestInit) {
  return handler(
    new Request(`http://localhost/api/workspace/git/proposals${path}`, init),
  );
}
function post(revision: unknown, origin = "http://localhost") {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ revision }),
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openlia-checkpoints-"));
  handler = createWorkspaceHandler({ workspaceRoot: root });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function proposal(): CheckpointProposal {
  git("init", "-b", "main");
  git("config", "user.name", "Tester");
  git("config", "user.email", "test@localhost");
  writeFileSync(join(root, "note.md"), "initial\n");
  git("add", "note.md");
  git("commit", "-m", "initial");
  writeFileSync(join(root, "note.md"), "reviewed\n");
  const script = resolve(
    import.meta.dir,
    "../../../..",
    "profile/plugins/openlia-workspace-git/git_proposals.py",
  );
  const code = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('checkpoints',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
e=m.Checkpoints(sys.argv[2]);s=e.inspect();print(json.dumps(e.propose(s['snapshot_id'],[{'message':'backup: reviewed note','rationale':'Save note','files':['note.md']}])) )`;
  const result = Bun.spawnSync(["python3", "-c", code, script, root]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

test("no repository returns an empty proposal list", async () => {
  const response = await request("");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ proposals: [] });
});
test("lists real frozen proposals, approves once and returns commit hashes", async () => {
  const draft = proposal();
  const response = await request("");
  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    proposals: CheckpointProposal[];
  };
  expect(payload.proposals[0]?.files[0]?.diff).toContain("+reviewed");
  const applied = await request(`/${draft.id}/approve`, post(1));
  expect(applied.status).toBe(200);
  const result = (await applied.json()) as CheckpointProposal;
  expect(result.status).toBe("applied");
  expect(result.hashes).toEqual([git("rev-parse", "HEAD")]);
  expect(git("status", "--porcelain")).toBe("");
  const retry = await request(`/${draft.id}/approve`, post(1));
  expect(((await retry.json()) as CheckpointProposal).hashes).toEqual(
    result.hashes,
  );
});
test("rejects cross-origin confirmation, invalid input and stale content", async () => {
  const draft = proposal();
  expect(
    (await request(`/${draft.id}/approve`, post(1, "https://evil.invalid")))
      .status,
  ).toBe(403);
  expect((await request(`/${draft.id}/approve`, post("1"))).status).toBe(400);
  expect((await request(`/${draft.id}/approve`, post(2))).status).toBe(409);
  writeFileSync(join(root, "note.md"), "newer user edit\n");
  const stale = await request(`/${draft.id}/approve`, post(1));
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { error: string }).error).toBe(
    "proposal_stale",
  );
});
test("requires UI authentication and allows dismissing without committing", async () => {
  const draft = proposal();
  const before = git("rev-parse", "HEAD");
  const dismissed = await request(`/${draft.id}/dismiss`, post(1));
  expect(((await dismissed.json()) as CheckpointProposal).status).toBe(
    "dismissed",
  );
  expect(git("rev-parse", "HEAD")).toBe(before);
  handler = createWorkspaceHandler({
    workspaceRoot: root,
    authRequired: true,
    passwordHash: await Bun.password.hash("test-password", {
      algorithm: "argon2id",
    }),
  });
  expect((await request("")).status).toBe(401);
  expect((await request(`/${draft.id}/approve`, post(1))).status).toBe(401);
});
