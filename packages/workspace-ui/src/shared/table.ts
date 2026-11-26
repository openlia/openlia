import { z } from "zod";

export const tablePaginationSchema = z
  .object({
    enabled: z.boolean().optional(),
    pageSize: z.number().int().min(1).optional(),
    showAllOption: z.boolean().optional(),
  })
  .strict();

export const tableLayoutSchema = z
  .object({
    horizontalScroll: z.boolean().optional(),
    wrapText: z.boolean().optional(),
    expandLongText: z.boolean().optional(),
  })
  .strict();

export const tableOpenUIOptionProps = {
  pagination: tablePaginationSchema.optional(),
  layout: tableLayoutSchema.optional(),
};

export type TablePaginationOptions = z.infer<typeof tablePaginationSchema>;
export type TableLayoutOptions = z.infer<typeof tableLayoutSchema>;
