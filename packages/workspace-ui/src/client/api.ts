import type {
  AuthLoginResponse,
  AuthSessionResponse,
  DocumentScope,
  WorkspaceCreateFileRequest,
  WorkspaceDeleteResponse,
  WorkspaceErrorResponse,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceMoveResponse,
  WorkspaceRenameResponse,
  WorkspaceTreeResponse,
  WorkspaceUploadFileResponse,
  WorkspaceWriteResponse,
} from "../shared/api";

export class ApiError extends Error {
  readonly status: number;
  readonly payload: WorkspaceErrorResponse | null;

  constructor(status: number, payload: WorkspaceErrorResponse | null) {
    super(payload?.error ?? "request_failed");
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export interface WorkspaceApi {
  loadTree(scope?: DocumentScope): Promise<WorkspaceTreeResponse>;
  loadSession(): Promise<AuthSessionResponse>;
  login(password: string, username?: string): Promise<AuthLoginResponse>;
  logout(): Promise<{ schema: 1; ok: true; authenticated: boolean }>;
  loadFile(path: string, scope?: DocumentScope): Promise<WorkspaceFile>;
  loadFileMetadata(
    path: string,
    scope?: DocumentScope,
  ): Promise<WorkspaceFileMetadata>;
  saveFile(
    path: string,
    content: string,
    expectedRevision: string,
    scope?: DocumentScope,
  ): Promise<WorkspaceWriteResponse>;
  createFile(
    input: WorkspaceCreateFileRequest,
    scope?: DocumentScope,
  ): Promise<WorkspaceWriteResponse>;
  uploadFile(
    destinationPath: string,
    file: File,
    scope?: DocumentScope,
  ): Promise<WorkspaceUploadFileResponse>;
  renameFile(
    path: string,
    newName: string,
    scope?: DocumentScope,
  ): Promise<WorkspaceRenameResponse>;
  moveFile(
    sourcePath: string,
    destinationDir: string,
    scope?: DocumentScope,
  ): Promise<WorkspaceMoveResponse>;
  deleteFile(
    path: string,
    expectedRevision?: string,
    scope?: DocumentScope,
  ): Promise<WorkspaceDeleteResponse>;
  deleteDirectory(
    path: string,
    scope?: DocumentScope,
  ): Promise<WorkspaceDeleteResponse>;
  rawUrl(path: string, scope?: DocumentScope): string;
  downloadUrl(path: string, scope?: DocumentScope): string;
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload as WorkspaceErrorResponse | null,
    );
  }
  return payload as T;
}

function apiBase(scope?: DocumentScope): string {
  return scope === "skills" ? "/api/skills" : "/api/workspace";
}

export const httpWorkspaceApi: WorkspaceApi = {
  loadTree(scope) {
    return requestJson<WorkspaceTreeResponse>(`${apiBase(scope)}/tree`);
  },
  loadSession() {
    return requestJson<AuthSessionResponse>("/api/auth/session");
  },
  login(password, username) {
    return requestJson<AuthLoginResponse>("/api/auth/login", {
      body: JSON.stringify({ password, ...(username ? { username } : {}) }),
      method: "POST",
    });
  },
  logout() {
    return requestJson<{ schema: 1; ok: true; authenticated: boolean }>(
      "/api/auth/logout",
      {
        method: "POST",
      },
    );
  },
  loadFile(path, scope) {
    const query = new URLSearchParams({ path });
    return requestJson<WorkspaceFile>(`${apiBase(scope)}/file?${query}`);
  },
  loadFileMetadata(path, scope) {
    const query = new URLSearchParams({ path });
    return requestJson<WorkspaceFileMetadata>(
      `${apiBase(scope)}/file-info?${query}`,
    );
  },
  saveFile(path, content, expectedRevision, scope) {
    return requestJson<WorkspaceWriteResponse>(`${apiBase(scope)}/file`, {
      body: JSON.stringify({
        content,
        expected_revision: expectedRevision,
        path,
        ...(scope ? { scope } : {}),
      }),
      method: "PUT",
    });
  },
  createFile(input, scope) {
    const targetScope = scope ?? input.scope;
    return requestJson<WorkspaceWriteResponse>(
      `${apiBase(targetScope)}/file/create`,
      {
        body: JSON.stringify({
          ...input,
          ...(targetScope ? { scope: targetScope } : {}),
        }),
        method: "POST",
      },
    );
  },
  uploadFile(destinationPath, file, scope) {
    const formData = new FormData();
    formData.set("path", destinationPath);
    formData.set("file", file);
    if (scope) {
      formData.set("scope", scope);
    }
    return requestJson<WorkspaceUploadFileResponse>(
      `${apiBase(scope)}/file/upload`,
      {
        body: formData,
        method: "POST",
      },
    );
  },
  renameFile(path, newName, scope) {
    return requestJson<WorkspaceRenameResponse>(
      `${apiBase(scope)}/file/rename`,
      {
        body: JSON.stringify({
          new_name: newName,
          path,
          ...(scope ? { scope } : {}),
        }),
        method: "POST",
      },
    );
  },
  moveFile(sourcePath, destinationDir, scope) {
    return requestJson<WorkspaceMoveResponse>(`${apiBase(scope)}/file/move`, {
      body: JSON.stringify({
        destination_dir: destinationDir,
        path: sourcePath,
        ...(scope ? { scope } : {}),
      }),
      method: "POST",
    });
  },
  deleteFile(path, expectedRevision, scope) {
    return requestJson<WorkspaceDeleteResponse>(`${apiBase(scope)}/file`, {
      body: JSON.stringify({
        ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
        path,
        ...(scope ? { scope } : {}),
      }),
      method: "DELETE",
    });
  },
  deleteDirectory(path, scope) {
    return requestJson<WorkspaceDeleteResponse>(`${apiBase(scope)}/directory`, {
      body: JSON.stringify({
        path,
        ...(scope ? { scope } : {}),
      }),
      method: "DELETE",
    });
  },
  rawUrl(path, scope) {
    return `${apiBase(scope)}/raw?${new URLSearchParams({ path })}`;
  },
  downloadUrl(path, scope) {
    return `${apiBase(scope)}/download?${new URLSearchParams({ path })}`;
  },
};
