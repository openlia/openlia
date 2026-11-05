import { z } from "zod";

const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const scalar = z.union([
  z.string().max(1000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const filters = z.record(field, scalar);
export const minionViewSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    label: z.string().min(1).max(100),
    reader: z.enum(["markdown", "json", "calendar"]),
    path: z
      .string()
      .regex(
        /^data\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/,
      ),
    fields: z.array(field).min(1).max(32),
    title_field: field,
    date_field: field,
    id_field: field.optional(),
    lookback_days: z.number().int().min(0).max(14).default(0),
    required_filters: z.array(field).max(8).default([]),
    max_records: z.number().int().min(1).max(100).default(20),
    max_files: z.number().int().min(1).max(200).default(100),
    max_bytes: z
      .number()
      .int()
      .min(1024)
      .max(4 * 1024 * 1024)
      .default(2 * 1024 * 1024),
    max_field_chars: z.number().int().min(40).max(1000).default(300),
  })
  .strict()
  .superRefine((view, ctx) => {
    for (const name of [
      view.title_field,
      view.date_field,
      ...view.required_filters,
      ...(view.id_field ? [view.id_field] : []),
    ]) {
      if (!view.fields.includes(name))
        ctx.addIssue({
          code: "custom",
          message: `${name} must be declared in fields`,
        });
    }
    if (view.path.split("/").some((part) => part === ".."))
      ctx.addIssue({ code: "custom", message: "Unsafe data path" });
  });
export const minionViewsSchema = z
  .object({ schema: z.literal(1), views: z.array(minionViewSchema).max(8) })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.views.map((view) => view.id)).size !== value.views.length)
      ctx.addIssue({ code: "custom", message: "Duplicate view id" });
  });
export const minionQuerySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    view: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    purpose: z.enum(["interactive", "briefing"]).default("interactive"),
    from: z.iso.date(),
    to: z.iso.date(),
    filters: filters.default({}),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    const days = (Date.parse(value.to) - Date.parse(value.from)) / 86400000;
    if (days < 1 || days > 31)
      ctx.addIssue({
        code: "custom",
        message: "Use an exclusive-end range of 1–31 days",
      });
  });
export const minionViewSettingsSchema = z
  .object({
    briefing: z.array(z.string()).max(8).default([]),
    scopes: z.record(z.string(), filters).default({}),
  })
  .strict();
export type MinionView = z.infer<typeof minionViewSchema>;
export type MinionQuery = z.infer<typeof minionQuerySchema>;
export const minionViewDescriptionSchema = z.object({
  schema: z.literal(1),
  id: z.string(),
  revision: z.string(),
  views: z.array(
    minionViewSchema.safeExtend({ briefing_enabled: z.boolean() }),
  ),
  settings: minionViewSettingsSchema,
});
export const minionQueryResultSchema = z.object({
  schema: z.literal(1),
  status: z.literal("ok"),
  id: z.string(),
  view: z.string(),
  from: z.iso.date(),
  to: z.iso.date(),
  observed_at: z.string(),
  revision: z.string(),
  records: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      fields: z.record(z.string(), scalar),
      source: z.string().startsWith("openlia://workspace/"),
    }),
  ),
  matched: z.number().int().nonnegative(),
  unknown_dates: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type MinionViewDescription = z.infer<typeof minionViewDescriptionSchema>;
export type MinionQueryResult = z.infer<typeof minionQueryResultSchema>;
