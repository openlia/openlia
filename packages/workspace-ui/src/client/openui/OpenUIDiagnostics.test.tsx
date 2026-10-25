import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { OpenUIDiagnostics } from "./OpenUIDiagnostics";

it("updates diagnostics from the live draft without saving it", () => {
  const { rerender } = render(
    <OpenUIDiagnostics content={'root = DomainCollection("travel")'} />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "OpenUI layout is valid.",
  );
  rerender(
    <OpenUIDiagnostics content={'root = DomainCollection("unsupported")'} />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "OpenUI layout diagnostics",
  );
  rerender(
    <OpenUIDiagnostics
      content={'root = RecordSectionView("Notes", "details")'}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "OpenUI layout is valid.",
  );
});
