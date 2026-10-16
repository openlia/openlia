import { createMockWorkspaceApi } from "./mockApi";
import { httpWorkspaceApi, type WorkspaceApi } from "./api";
import { startWorkspaceApi } from "./startApi";

type MockScenario = "auth" | "conflict" | "empty" | "error" | "loading";

function mockScenario(value: string | null | undefined): MockScenario | null {
  return value === "auth" ||
    value === "conflict" ||
    value === "empty" ||
    value === "error" ||
    value === "loading"
    ? value
    : null;
}

export function createWorkspaceClientApi(
  requestedScenario?: string | null,
): WorkspaceApi {
  if (
    !import.meta.env.DEV ||
    import.meta.env.VITE_WORKSPACE_UI_MODE === "real"
  ) {
    return startWorkspaceApi;
  }

  const scenario =
    mockScenario(requestedScenario) ??
    (typeof window === "undefined"
      ? null
      : mockScenario(
          new URLSearchParams(window.location.search).get("scenario"),
        )) ??
    mockScenario(import.meta.env.VITE_WORKSPACE_UI_SCENARIO) ??
    "default";
  return createMockWorkspaceApi({ scenario });
}

export const workspaceClientApi = createWorkspaceClientApi();

export { httpWorkspaceApi };
