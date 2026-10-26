import { z } from "zod";
import type {
  WorkspaceDomainRecordSummary,
  WorkspaceFileMetadata,
} from "./api";

export const PROJECT_MANIFEST_FILENAME = "project-manifest.toml";
export const DEFAULT_PROJECT_UI_ENTRY = "ui.openui";

export type ProjectQueryType = "count" | "group_count" | "sum" | "filter";

export interface ProjectQueryDefinition {
  type: ProjectQueryType;
  field?: string | undefined;
  value?:
    | string
    | number
    | boolean
    | Array<string | number | boolean>
    | undefined;
  where?:
    | Record<
        string,
        string | number | boolean | Array<string | number | boolean>
      >
    | undefined;
}

export interface ProjectMutationsDefinition {
  editable_fields?: string[] | undefined;
  checklist_sections?: string[] | undefined;
}

export interface ProjectPromptDefinition {
  id: string;
  label: string;
  prompt: string;
}

export interface ProjectSortDefinition {
  field: string;
  direction?: "asc" | "desc" | undefined;
}

export interface ProjectManifest {
  version: number;
  project: {
    id: string;
    name: string;
    description?: string | undefined;
    icon?: string | undefined;
  };
  data: {
    records_glob?: string | undefined;
    exclude?: string[] | undefined;
    template?: string | undefined;
    schema?: string | undefined;
    status_field?: string | undefined;
    default_sort?: ProjectSortDefinition | undefined;
    queries?: Record<string, ProjectQueryDefinition> | undefined;
  };
  ui: {
    entry: string;
  };
  logic?:
    | {
        skills?: string[] | undefined;
        mutations?: ProjectMutationsDefinition | undefined;
        prompts?: ProjectPromptDefinition[] | undefined;
      }
    | undefined;
}

export interface ProjectSummary {
  path: string;
  id: string;
  name: string;
  description?: string | undefined;
  icon?: string | undefined;
  manifest_path: string;
  ui_path: string;
  template_path?: string | undefined;
  schema_path?: string | undefined;
  skills: string[];
  record_count: number;
  invalid_record_count: number;
  renderable?: boolean | undefined;
  render_errors?: string[] | undefined;
}

export interface WorkspaceProjectsResponse {
  schema: 1;
  projects: ProjectSummary[];
}

export interface WorkspaceProjectResponse {
  schema: 1;
  project: ProjectSummary;
  manifest: ProjectManifest;
  manifest_raw: string;
  ui_content: string;
  records: WorkspaceDomainRecordSummary[];
  queries: Record<string, unknown>;
  schema_json?: Record<string, unknown> | undefined;
  template_headings?: string[] | undefined;
  project_files: WorkspaceFileMetadata[];
  renderable?: boolean | undefined;
  render_errors?: string[] | undefined;
}

// Shared OpenUI component prop schemas for Project UIs (used by both client library & server validator)
export const projectOpenUIProps = {
  Grid: z.object({
    children: z.array(z.any()),
    columns: z.number().optional(),
    gap: z.string().optional(),
  }),
  DomainHeader: z.object({
    title: z.string().describe("Project title"),
    description: z.string().optional().describe("Project description"),
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
  RecordTable: z.object({
    columns: z.union([z.array(z.string()), z.string()]).optional(),
    filterStatus: z.string().optional(),
    filterPriority: z.string().optional(),
    query: z.string().optional().describe("Named query from [data.queries]"),
    limit: z.number().optional(),
    title: z.string().optional(),
  }),
  RecordKanban: z.object({
    groupBy: z.string().optional(),
    columns: z.array(z.string()).optional(),
    title: z.string().optional(),
  }),
  FinanceOverview: z.object({
    journalPath: z.string().optional(),
  }),
};
