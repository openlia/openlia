import { createContext, useContext } from "react";
import type { WorkspaceApi } from "../api";
import type { WorkspaceDomainInfo } from "../../shared/api";

export interface OpenLiaOpenUIContextValue {
  financeApi?:
    | Pick<
        WorkspaceApi,
        | "loadFinanceContext"
        | "loadFinanceReport"
        | "createFinanceMapping"
        | "validateFinanceMapping"
      >
    | undefined;
  calendarApi?:
    | Pick<WorkspaceApi, "loadCalendar" | "createCalendarEvent">
    | undefined;
  loadFile?: WorkspaceApi["loadFile"] | undefined;
  domainPath?: string | undefined;
  filePath?: string | undefined;
  domainInfo?: WorkspaceDomainInfo | undefined;
  onOpenRecord?: ((path: string) => void) | undefined;
  onSendChatPrompt?: ((prompt: string) => void) | undefined;
}

const OpenLiaOpenUIContext = createContext<OpenLiaOpenUIContextValue>({});

export const OpenLiaOpenUIProvider = OpenLiaOpenUIContext.Provider;

export function useOpenLiaOpenUI(): OpenLiaOpenUIContextValue {
  return useContext(OpenLiaOpenUIContext);
}
