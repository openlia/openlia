import { z } from "zod";

// Shared by the renderer and server diagnostics. Positional argument order is
// part of the OpenUI contract: append optional properties, never reorder them.
export const domainOpenUIProps = {
  DomainHeader: z.object({
    title: z.string().describe("Domain title"),
    description: z.string().optional().describe("Domain purpose"),
    recordCount: z.number().optional().describe("Record count override"),
  }),
  MetricCard: z.object({
    label: z.string(),
    value: z.union([z.string(), z.number()]),
    subtext: z.string().optional(),
    tone: z
      .enum(["neutral", "primary", "success", "warning", "error"])
      .optional(),
  }),
  RecordKanban: z.object({
    groupBy: z.string().optional(),
    columns: z.array(z.string()).optional(),
    title: z.string().optional(),
  }),
  RecordTable: z.object({
    filterStatus: z.string().optional(),
    filterPriority: z.string().optional(),
    limit: z.number().optional(),
    title: z.string().optional(),
  }),
  RecordHeaderCard: z.object({
    title: z.string().optional(),
    status: z.string().optional(),
    priority: z.string().optional(),
    dueDate: z.string().optional(),
  }),
  FrontmatterEditorCard: z.object({
    title: z.string().optional(),
    fields: z.array(z.string()).optional(),
  }),
  ChecklistSection: z.object({
    heading: z
      .string()
      .describe("Markdown H2 heading containing checklist items"),
    title: z.string().optional(),
    allowAdd: z.boolean().optional(),
  }),
  MarkdownSectionCard: z.object({
    heading: z.string(),
    title: z.string().optional(),
  }),
  ClaimProvenanceCard: z.object({
    kind: z.string().optional(),
    status: z.string().optional(),
    confidence: z.union([z.string(), z.number()]).optional(),
    sourceRef: z.string().optional(),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
    reviewAfter: z.string().optional(),
  }),
  DecisionMatrixCard: z.object({
    chosenOption: z.string().optional(),
    recommendation: z.string().optional(),
    options: z.array(z.string()).optional(),
  }),
  DomainCollection: z.object({
    kind: z.enum(["travel", "people", "monitors", "shopping"]),
  }),
  RecordSectionView: z.object({
    heading: z.string(),
    kind: z.enum(["schedule", "bookings", "comparison", "timeline", "details"]),
    title: z.string().optional(),
  }),
  RecordProfile: z.object({
    kind: z.enum(["travel", "people", "monitors", "shopping", "accounts"]),
  }),
  FinanceOverview: z.object({ journalPath: z.string().optional() }),
};
