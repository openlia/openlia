import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createParser, Renderer } from "@openuidev/react-lang";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceDomainRecordSummary } from "../../shared/api";
import {
  OpenLiaOpenUIProvider,
  type OpenLiaOpenUIContextValue,
} from "./context";
import { openliaLibrary } from "./library";
import { updateRecordSectionContent } from "./recordMutator";

function record(
  title: string,
  frontmatter: Record<string, unknown>,
): WorkspaceDomainRecordSummary {
  return {
    title,
    frontmatter,
    path: `${title}.md`,
    filename: `${title}.md`,
    modified_at: "2026-10-25",
    size: 0,
    revision: "1",
    sections: [],
    excerpt: "",
  };
}

function program(source: string, context: OpenLiaOpenUIContextValue = {}) {
  return render(
    <OpenLiaOpenUIProvider value={context}>
      <Renderer library={openliaLibrary} response={source} />
    </OpenLiaOpenUIProvider>,
  );
}

describe("specialized domain views", () => {
  it("all feature-owned layouts parse against the actual renderer library", () => {
    const features = resolve(import.meta.dirname, "../../../../../features");
    const parser = createParser(openliaLibrary.toJSONSchema());
    for (const domain of [
      "personal-finance",
      "travel",
      "shopping",
      "monitors",
      "people",
      "decision-analysis",
    ]) {
      const root = join(features, domain, "workspace");
      for (const path of readdirSync(root, { recursive: true })
        .map(String)
        .filter((path) => path.endsWith(".openui"))) {
        expect(
          parser.parse(readFileSync(join(root, path), "utf8")).meta.errors,
          path,
        ).toEqual([]);
      }
    }
  });

  it("sorts trips chronologically and exposes destinations and alerts", () => {
    program('root = DomainCollection("travel")', {
      records: [
        record("Later", { destination: "Paris", start_date: "2026-12-01" }),
        record("Sooner", {
          destination: "Tokyo",
          start_date: "2026-11-01",
          alerts: ["Check visa"],
        }),
      ],
    });
    const overview = screen.getByRole("region", { name: "travel overview" });
    expect(
      within(overview)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Sooner", "Later"]);
    expect(screen.getByText("Check visa")).toBeDefined();
  });

  it("searches people and filters relationships without inventing recency", () => {
    const open = vi.fn();
    program('root = DomainCollection("people")', {
      onOpenRecord: open,
      records: [
        record("Alice", { relationship: "client" }),
        record("Bob", { relationship: "friend" }),
      ],
    });
    fireEvent.change(screen.getByLabelText("Filter by relationship"), {
      target: { value: "client" },
    });
    expect(screen.queryByRole("button", { name: "Bob" })).toBeNull();
    expect(screen.getByText("Last contact unknown")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Alice" }));
    expect(open).toHaveBeenCalledWith("Alice.md");
    fireEvent.change(screen.getByLabelText("Search people"), {
      target: { value: "Nobody" },
    });
    expect(screen.getByText("No matching records.")).toBeDefined();
  });

  it("shows monitor unknown health and blocks executable source links", () => {
    program('root = DomainCollection("monitors")', {
      records: [
        record("Watch", { status: "active", source: "javascript:alert(1)" }),
      ],
    });
    expect(screen.getByText("unknown", { selector: "span" })).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps shopping currencies separate and surfaces rejected mutations", async () => {
    const update = vi.fn().mockRejectedValue(new Error("Revision conflict"));
    program('root = DomainCollection("shopping")', {
      records: [
        record("Camera", {
          status: "researching",
          budget: 100,
          currency: "USD",
        }),
        record("Bag", {
          status: "purchased",
          actual_price: 50,
          currency: "EUR",
        }),
      ],
      schemaJson: {
        properties: {
          status: { enum: [null, "wishlist", "researching", "purchased"] },
        },
      },
      onUpdateRecordFrontmatter: update,
    });
    expect(screen.getByText(/USD: budget 100/)).toBeDefined();
    expect(
      screen.getByText(/EUR: budget unknown · purchased 50/),
    ).toBeDefined();
    fireEvent.change(screen.getByLabelText("Status for Camera"), {
      target: { value: "wishlist" },
    });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Revision conflict",
      ),
    );
    expect(update).toHaveBeenCalledWith("Camera.md", { status: "wishlist" });
  });

  it("renders comparison tables and round-trips section edits without touching other sections", async () => {
    const initial =
      "# Product\n## Candidate Options\n| Option | Price |\n| --- | --- |\n| Model A | 120 USD |\n## Keep\nUntouched\n";
    const saved = vi.fn();
    function Harness() {
      const [content, setContent] = useState(initial);
      return (
        <OpenLiaOpenUIProvider
          value={{
            currentRecordPath: "shopping/item.md",
            currentRecordContent: content,
            onUpdateSectionContent: (_path, heading, draft) => {
              const next = updateRecordSectionContent(content, heading, draft);
              saved(next);
              setContent(next);
            },
          }}
        >
          <Renderer
            library={openliaLibrary}
            response={
              'root = RecordSectionView("Candidate Options", "comparison")'
            }
          />
        </OpenLiaOpenUIProvider>
      );
    }
    render(<Harness />);
    expect(screen.getByRole("table")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Candidate Options" }),
    );
    fireEvent.change(screen.getByLabelText("Candidate Options"), {
      target: { value: "New comparison" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save section" }));
    await waitFor(() =>
      expect(screen.getByText("New comparison")).toBeDefined(),
    );
    expect(saved.mock.calls[0]?.[0]).toContain("## Keep\nUntouched\n");
  });

  it("retains section drafts after a save failure", async () => {
    program('root = RecordSectionView("Itinerary Outline", "schedule")', {
      currentRecordPath: "travel/trip.md",
      onUpdateSectionContent: async () => {
        throw new Error("Offline");
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Itinerary Outline" }),
    );
    fireEvent.change(screen.getByLabelText("Itinerary Outline"), {
      target: { value: "Day 1: Flight" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save section" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Offline"),
    );
    expect(
      (screen.getByLabelText("Itinerary Outline") as HTMLTextAreaElement).value,
    ).toBe("Day 1: Flight");
  });

  it("reads the decision matrix from the current record", () => {
    program("root = DecisionMatrixCard()", {
      currentRecordContent:
        "# Decision\n## Options Considered\n| Option | Benefit |\n| --- | --- |\n| SQLite | Simple operations |\n## Criteria And Weights\nCost: 5\n## Recommendation\nEvaluate SQLite first.\n",
    });
    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("Evaluate SQLite first.")).toBeDefined();
    expect(screen.getByText("Cost: 5")).toBeDefined();
  });
});
