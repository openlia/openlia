import { z } from "zod";
import { sankeyDataSchema } from "./charts";

export const financeContractSchema = z.object({
  available: z.boolean(),
  errors: z.array(z.string()),
  revision: z.string(),
  templatePath: z.string(),
  schemaPath: z.string(),
  defaults: z.record(z.string(), z.unknown()),
  body: z.string(),
  schemaJson: z.record(z.string(), z.unknown()),
});
export type FinanceContract = z.infer<typeof financeContractSchema>;
export const financeMappingSchema = z.object({
  path: z.string(),
  title: z.string(),
  revision: z.string(),
  fields: z.record(z.string(), z.unknown()),
  valid: z.boolean(),
});
export type FinanceMapping = z.infer<typeof financeMappingSchema>;
export const financeContextSchema = z.object({
  schema: z.literal(1),
  path: z.string(),
  journals: z.array(z.string()),
  includedJournals: z.array(z.string()),
  suggestedJournal: z.string().nullable(),
  mappings: z.array(financeMappingSchema),
  contract: financeContractSchema,
  warnings: z.array(z.string()),
});
export type FinanceContextResponse = z.infer<typeof financeContextSchema>;
export const financeReportRequestSchema = z
  .object({
    path: z.string(),
    journal: z.string(),
    from: z.string(),
    to: z.string(),
    accountPrefix: z.string().max(300).default(""),
  })
  .strict();
export type FinanceReportRequest = z.infer<typeof financeReportRequestSchema>;
const reportRow = z.object({
  account: z.string(),
  type: z.string(),
  amounts: z.array(z.record(z.string(), z.string())),
});
export const financeReportSchema = z.object({
  schema: z.literal(1),
  status: z.enum(["ok", "missing", "invalid", "unavailable"]),
  message: z.string(),
  scope: financeReportRequestSchema,
  revision: z.string(),
  files: z.array(z.string()),
  periods: z.array(z.string()),
  commodities: z.array(z.string()),
  accounts: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      declared: z.boolean(),
      used: z.boolean(),
    }),
  ),
  changes: z.array(reportRow),
  balances: z.array(reportRow),
  flows: z.record(
    z.string(),
    z.object({ data: sankeyDataSchema.nullable(), reason: z.string() }),
  ),
  warnings: z.array(z.string()),
  commands: z.array(z.string()),
});
export type FinanceReport = z.infer<typeof financeReportSchema>;
export const financeCreateMappingSchema = z
  .object({
    path: z.string(),
    requestId: z.string().uuid(),
    contractRevision: z.string(),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/),
    fields: z.record(z.string(), z.unknown()),
    body: z.string().max(64000),
  })
  .strict();
export type FinanceCreateMapping = z.infer<typeof financeCreateMappingSchema>;
export const financeMappingResultSchema = z.object({
  schema: z.literal(1),
  mapping: financeMappingSchema,
  warnings: z.array(z.string()),
});
export type FinanceMappingResult = z.infer<typeof financeMappingResultSchema>;
export const financeMappingValidationSchema = z.object({
  schema: z.literal(1),
  valid: z.boolean(),
  errors: z.array(z.string()),
});
export type FinanceMappingValidation = z.infer<
  typeof financeMappingValidationSchema
>;

export const financeOpenUIProps = {
  Finance: z.object({
    children: z.array(z.any()),
    journal: z.string().optional(),
  }),
  FinanceOverview: z.object({ title: z.string().optional() }),
  FinanceChart: z.object({
    report: z.enum(["income-expenses", "spending", "balances", "flows"]),
    kind: z.enum(["bar", "line", "pie", "sankey"]).optional(),
    title: z.string().optional(),
  }),
  FinanceAccounts: z.object({ title: z.string().optional() }),
};
