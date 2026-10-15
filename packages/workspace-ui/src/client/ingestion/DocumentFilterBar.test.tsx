import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { DocumentFilterBar } from "./DocumentFilterBar";

const facets = {
  tags: {},
  correspondents: {},
  document_types: {},
  review_status: { unreviewed: 1, reviewed: 2 },
  processing_status: {},
};

test("uses Library as the collection view with a review filter", () => {
  const onReviewFilterChange = vi.fn();

  render(
    <DocumentFilterBar
      scope="library"
      onScopeChange={vi.fn()}
      reviewFilter="all"
      onReviewFilterChange={onReviewFilterChange}
      searchQuery=""
      onSearchChange={vi.fn()}
      onTagChange={vi.fn()}
      onCorrespondentChange={vi.fn()}
      onDocTypeChange={vi.fn()}
      facets={facets}
      onOpenUpload={vi.fn()}
    />,
  );

  expect(screen.queryByRole("button", { name: /Needs Review/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Library" })).toHaveClass(
    "tab-active",
  );

  const reviewFilter = screen.getByRole("combobox", {
    name: "Review filter",
  });
  expect(reviewFilter).toHaveValue("all");
  expect(
    screen.getByRole("option", { name: "Needs Review (1)" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("option", { name: "Reviewed (2)" }),
  ).toBeInTheDocument();

  fireEvent.change(reviewFilter, { target: { value: "needs-review" } });
  expect(onReviewFilterChange).toHaveBeenCalledWith("needs-review");
});
