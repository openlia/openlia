import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CheckpointProposal } from "../shared/checkpoints";
import { CheckpointProposals } from "./CheckpointProposals";

afterEach(cleanup);
const draft: CheckpointProposal = {
  id: "a".repeat(32),
  revision: 3,
  snapshot_id: "b".repeat(64),
  base_head: "c".repeat(40),
  status: "pending",
  created_at: "2026-10-26",
  updated_at: "2026-10-26",
  session_id: null,
  commits: [
    {
      message: "backup: update note",
      rationale: "Keep related changes together",
      files: ["note.md"],
    },
  ],
  files: [
    {
      path: "note.md",
      oid: "d".repeat(40),
      mode: "100644",
      diff: "+reviewed content",
    },
  ],
  excluded: ["later.md"],
  hashes: [],
};
function props(proposal = draft) {
  return {
    api: {
      loadCheckpointProposals: vi
        .fn()
        .mockResolvedValue({ proposals: [proposal] }),
      approveCheckpoint: vi.fn().mockResolvedValue({
        ...proposal,
        status: "applied",
        hashes: ["hash"],
      }),
      dismissCheckpoint: vi
        .fn()
        .mockResolvedValue({ ...proposal, status: "dismissed" }),
    },
    onAskLia: vi.fn(),
    onApplied: vi.fn(),
  };
}
it("shows reviewed diffs and requires explicit confirmation of the displayed revision", async () => {
  const input = props();
  render(<CheckpointProposals {...input} />);
  await screen.findByText("1. backup: update note");
  expect(screen.getByText("+reviewed content")).toBeInTheDocument();
  expect(input.api.approveCheckpoint).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review & confirm" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(input.api.approveCheckpoint).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm commits" }));
  await waitFor(() =>
    expect(input.api.approveCheckpoint).toHaveBeenCalledWith(draft.id, 3),
  );
  await waitFor(() => expect(input.onApplied).toHaveBeenCalledOnce());
});
it("disables stale approval and routes revisions to chat without committing", async () => {
  const input = props({ ...draft, stale: true });
  render(<CheckpointProposals {...input} />);
  await screen.findByText("Needs refresh");
  expect(
    screen.getByRole("button", { name: "Review & confirm" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Revise in chat" }));
  expect(input.onAskLia.mock.calls[0]?.[0]).toContain(
    `proposal ${draft.id}, revision 3`,
  );
  expect(input.api.approveCheckpoint).not.toHaveBeenCalled();
});
it("sends a review prompt and dismisses without approving", async () => {
  const input = props();
  render(<CheckpointProposals {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "Propose commits" }));
  expect(input.onAskLia.mock.calls[0]?.[0]).toContain("do not commit");
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    expect(input.api.dismissCheckpoint).toHaveBeenCalledWith(draft.id, 3),
  );
  expect(input.api.approveCheckpoint).not.toHaveBeenCalled();
});
it("shows stale errors without automatically approving another revision", async () => {
  const input = props();
  input.api.approveCheckpoint.mockRejectedValue(
    new Error("proposal_revision_conflict"),
  );
  render(<CheckpointProposals {...input} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Review & confirm" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm commits" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "proposal revision conflict",
  );
  expect(input.api.approveCheckpoint).toHaveBeenCalledOnce();
});
