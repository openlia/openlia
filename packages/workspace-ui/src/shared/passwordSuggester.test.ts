import { describe, expect, test } from "vitest";
import type { DocumentPasswordProfile } from "./api";
import {
  extractKeywords,
  levenshteinDistance,
  matchesGlob,
  stringSimilarity,
  suggestPasswordProfiles,
} from "./passwordSuggester";

describe("passwordSuggester", () => {
  test("computes Levenshtein distance accurately", () => {
    expect(levenshteinDistance("chase", "chase")).toBe(0);
    expect(levenshteinDistance("chase", "chse")).toBe(1); // deletion
    expect(levenshteinDistance("chse", "chase")).toBe(1); // insertion
    expect(levenshteinDistance("chase", "phase")).toBe(1); // substitution
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("", "abc")).toBe(3);
  });

  test("calculates normalized string similarity", () => {
    expect(stringSimilarity("payroll", "payroll")).toBe(1.0);
    expect(stringSimilarity("payroll", "payrol")).toBeCloseTo(0.857, 2);
    expect(stringSimilarity("completely", "different")).toBeLessThan(0.3);
  });

  test("extracts keywords while ignoring extensions and pure numbers", () => {
    expect(extractKeywords("chase_statement_2026.pdf")).toEqual([
      "chase",
      "statement",
    ]);
    expect(extractKeywords("acme-payroll-q3.xlsx")).toEqual([
      "acme",
      "payroll",
      "q3",
    ]);
  });

  test("matches glob wildcards correctly", () => {
    expect(matchesGlob("*chase*", "chase_checking_2026.pdf")).toBe(true);
    expect(matchesGlob("sample_*.pdf", "sample_protected.pdf")).toBe(true);
    expect(matchesGlob("*.xlsx", "sample_protected.xlsx")).toBe(true);
    expect(matchesGlob("*bank*", "sample_protected.pdf")).toBe(false);
  });

  test("suggests password profiles using real-world fixtures and metadata", () => {
    const profiles: DocumentPasswordProfile[] = [
      {
        profile_id: "pdf_vault_key",
        label: "Protected PDF Secret",
        description: "Official documents and reports that are password locked",
        hint: "Vault key for reports",
        patterns: ["*protected*.pdf", "*report*"],
      },
      {
        profile_id: "acme_payroll",
        label: "Acme Corp Payroll",
        description: "Monthly salary sheets and expense reports",
        hint: "Employee ID (XX-XXXX)",
        patterns: ["*payroll*.xlsx", "*salary*"],
      },
      {
        profile_id: "chase_bank",
        label: "Chase Banking",
        description: "Monthly checking statements",
        hint: "Last 4 digits of SSN",
        patterns: ["*chase*"],
      },
    ];

    // 1. Suggest for sample_protected.pdf
    const pdfSuggestions = suggestPasswordProfiles(
      { filename: "sample_protected.pdf" },
      profiles,
    );
    expect(pdfSuggestions.length).toBeGreaterThan(0);
    const topPdf = pdfSuggestions[0]!;
    expect(topPdf.profile.profile_id).toBe("pdf_vault_key");
    expect(topPdf.score).toBeGreaterThanOrEqual(60);
    expect(topPdf.match_reasons.some((r) => r.includes("Pattern match"))).toBe(
      true,
    );

    // 2. Suggest for sample_protected.xlsx matching protected excel
    const excelSuggestions = suggestPasswordProfiles(
      { filename: "sample_protected.xlsx", title: "Protected Excel Document" },
      profiles,
    );
    expect(excelSuggestions.length).toBeGreaterThan(0);
    expect(excelSuggestions[0]!.profile.profile_id).toBe("pdf_vault_key");

    // 3. Suggest for conversational message / Telegram bot ingestion
    const chatSuggestions = suggestPasswordProfiles(
      {
        filename: "statement_jan.pdf",
        message: "Here is my Chase bank statement from last week",
      },
      profiles,
    );
    expect(chatSuggestions.length).toBeGreaterThan(0);
    expect(chatSuggestions[0]!.profile.profile_id).toBe("chase_bank");
    expect(chatSuggestions[0]!.profile.hint).toBe("Last 4 digits of SSN");
  });
});
