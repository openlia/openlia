import { MaintainerService } from "./engine";
import { applyDeterministicFix, previewFix } from "./fixes";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0] ?? "status";
  const workspaceRoot =
    process.env.OPENLIA_WORKSPACE_ROOT ?? "/opt/data/workspace";
  const maintainerRoot = process.env.OPENLIA_MAINTAINER_ROOT;

  const service = new MaintainerService({
    workspaceRoot,
    ...(maintainerRoot ? { maintainerRoot } : {}),
  });

  try {
    if (command === "status" || command === "overview") {
      printJson(service.getOverview());
      return;
    }

    if (command === "audit") {
      printJson(service.runWorkspaceAudit());
      return;
    }

    if (command === "validate-files") {
      const files = args.slice(1);
      const reconciled = service.validateAndReconcilePaths(files);
      const openFindings = reconciled.filter((f) => f.state === "open");
      printJson({
        schema: 1,
        ok: true,
        files,
        open_findings: openFindings,
        all_findings: reconciled,
      });
      return;
    }

    if (command === "ignore") {
      const issueId = args[1];
      const reason = args[2];
      if (!issueId) {
        throw new Error("usage: cli.ts ignore <issue_id> [reason]");
      }
      const updated = service.db.ignoreIssue({
        issueId,
        actor: "cli",
        ...(reason ? { reason } : {}),
      });
      printJson({ schema: 1, ok: Boolean(updated), finding: updated });
      return;
    }

    if (command === "restore") {
      const issueId = args[1];
      if (!issueId) {
        throw new Error("usage: cli.ts restore <issue_id>");
      }
      const updated = service.db.restoreIssue(issueId);
      printJson({ schema: 1, ok: Boolean(updated), finding: updated });
      return;
    }

    if (command === "fix-preview") {
      const issueId = args[1];
      if (!issueId) {
        throw new Error("usage: cli.ts fix-preview <issue_id>");
      }
      printJson(previewFix(service, issueId));
      return;
    }

    if (command === "fix-apply") {
      const issueId = args[1];
      const expectedRevision = args[2];
      if (!issueId || !expectedRevision) {
        throw new Error(
          "usage: cli.ts fix-apply <issue_id> <expected_revision>",
        );
      }
      printJson(
        applyDeterministicFix(service, {
          issueId,
          expectedRevision,
          actor: "cli",
        }),
      );
      return;
    }

    throw new Error(`unknown command: ${command}`);
  } finally {
    service.close();
  }
}

if (import.meta.main) {
  main();
}
