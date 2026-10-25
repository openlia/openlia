import { createParser } from "@openuidev/react-lang";
import { describe, expect, it } from "vitest";
import { openliaLibrary } from "./library";
import {
  DEFAULT_DOMAIN_OPENUI,
  isChecklistHeading,
  synthesizeDomainOpenUI,
} from "./synthesizer";

describe("synthesizer", () => {
  const parser = createParser(openliaLibrary.toJSONSchema());

  it("identifies checklist heading keywords", () => {
    expect(isChecklistHeading("Next Tasks")).toBe(true);
    expect(isChecklistHeading("Substeps")).toBe(true);
    expect(isChecklistHeading("Key Results")).toBe(true);
    expect(isChecklistHeading("Open Loops")).toBe(true);
    expect(isChecklistHeading("Objective")).toBe(false);
    expect(isChecklistHeading("Notes & Context")).toBe(false);
  });

  it("all pre-bundled DEFAULT_DOMAIN_OPENUI programs parse without syntax errors", () => {
    for (const [domain, uis] of Object.entries(DEFAULT_DOMAIN_OPENUI)) {
      const dashParsed = parser.parse(uis.dashboardOpenUI);
      expect(
        dashParsed.meta.errors,
        `Dashboard errors in ${domain}`,
      ).toHaveLength(0);

      const recParsed = parser.parse(uis.recordOpenUI);
      expect(recParsed.meta.errors, `Record errors in ${domain}`).toHaveLength(
        0,
      );
    }
  });

  it("synthesizes valid openui for a custom domain with schema and template headings", () => {
    const customResult = synthesizeDomainOpenUI(
      "inventory/spare-parts",
      {
        path: "inventory/spare-parts",
        label: "Spare Parts",
        purpose: "Tracking machinery spare parts",
      },
      {
        properties: {
          status: { type: "string", enum: ["in-stock", "low", "ordered"] },
          part_number: { type: "string" },
        },
      },
      ["Specifications", "Checklist / Inspection", "Maintenance Notes"],
    );

    expect(customResult.dashboardOpenUI).toContain("DomainHeader");
    expect(customResult.dashboardOpenUI).toContain('RecordKanban("status")');
    expect(customResult.recordOpenUI).toContain("RecordHeaderCard");
    expect(customResult.recordOpenUI).toContain(
      'ChecklistSection("Checklist / Inspection")',
    );

    const dashParsed = parser.parse(customResult.dashboardOpenUI);
    expect(dashParsed.meta.errors).toHaveLength(0);

    const recParsed = parser.parse(customResult.recordOpenUI);
    expect(recParsed.meta.errors).toHaveLength(0);
  });
});
