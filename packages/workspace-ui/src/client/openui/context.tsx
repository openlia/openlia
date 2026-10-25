import { createContext, useContext } from "react";
import type {
  WorkspaceDomainInfo,
  WorkspaceDomainRecordSummary,
} from "../../shared/api";

export interface OpenLiaOpenUIContextValue {
  domainPath?: string | undefined;
  domainInfo?: WorkspaceDomainInfo | undefined;
  schemaJson?: Record<string, unknown> | undefined;
  templateHeadings?: string[] | undefined;
  currentRecordPath?: string | undefined;
  currentRecordContent?: string | undefined;
  onOpenRecord?: ((path: string) => void) | undefined;
  onCreateRecord?: ((domainPath?: string) => void) | undefined;
  onEditOpenUI?: ((openuiPath?: string) => void) | undefined;
  onUpdateRecordFrontmatter?:
    | ((path: string, updates: Record<string, unknown>) => Promise<void> | void)
    | undefined;
  onToggleChecklistItem?:
    | ((
        path: string,
        heading: string | undefined,
        itemIndex: number,
        checked?: boolean,
      ) => Promise<void> | void)
    | undefined;
  onAddChecklistItem?:
    | ((
        path: string,
        heading: string,
        itemText: string,
      ) => Promise<void> | void)
    | undefined;
  onUpdateSectionContent?:
    | ((
        path: string,
        heading: string,
        markdownContent: string,
      ) => Promise<void> | void)
    | undefined;
  records?: WorkspaceDomainRecordSummary[] | undefined;
}

const OpenLiaOpenUIContext = createContext<OpenLiaOpenUIContextValue>({});

export const OpenLiaOpenUIProvider = OpenLiaOpenUIContext.Provider;

export function useOpenLiaOpenUI(): OpenLiaOpenUIContextValue {
  return useContext(OpenLiaOpenUIContext);
}
