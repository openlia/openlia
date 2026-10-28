import { createContext, useContext } from "react";
import type { WorkspaceApi } from "../api";
import type {
  ProjectManifest,
  ProjectSummary,
  WorkspaceDomainInfo,
  WorkspaceDomainRecordSummary,
} from "../../shared/api";

export interface OpenLiaOpenUIContextValue {
  calendarApi?:
    | Pick<WorkspaceApi, "loadCalendar" | "createCalendarEvent">
    | undefined;
  loadFile?: WorkspaceApi["loadFile"] | undefined;
  project?: ProjectSummary | undefined;
  manifest?: ProjectManifest | undefined;
  queries?: Record<string, unknown> | undefined;
  domainPath?: string | undefined;
  domainInfo?: WorkspaceDomainInfo | undefined;
  schemaJson?: Record<string, unknown> | undefined;
  templateHeadings?: string[] | undefined;
  onOpenRecord?: ((path: string) => void) | undefined;
  onCreateRecord?: ((domainPath?: string) => void) | undefined;
  onEditOpenUI?: ((openuiPath?: string) => void) | undefined;
  onImproveUI?: (() => void) | undefined;
  onUpdateRecordFrontmatter?:
    | ((path: string, updates: Record<string, unknown>) => Promise<void> | void)
    | undefined;
  records?: WorkspaceDomainRecordSummary[] | undefined;
  currentRecordContent?: string | undefined;
}

const OpenLiaOpenUIContext = createContext<OpenLiaOpenUIContextValue>({});

export const OpenLiaOpenUIProvider = OpenLiaOpenUIContext.Provider;

export function useOpenLiaOpenUI(): OpenLiaOpenUIContextValue {
  return useContext(OpenLiaOpenUIContext);
}
