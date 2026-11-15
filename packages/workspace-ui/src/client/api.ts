import type {
  AuthLoginResponse,
  AuthSessionResponse,
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
  loadTree(): Promise<WorkspaceTreeResponse>;
  loadSession(): Promise<AuthSessionResponse>;
  login(password: string, username?: string): Promise<AuthLoginResponse>;
  logout(): Promise<{ schema: 1; ok: true; authenticated: boolean }>;
  loadFile(path: string): Promise<WorkspaceFile>;
  loadFileMetadata(path: string): Promise<WorkspaceFileMetadata>;
  saveFile(
    path: string,
    content: string,
    expectedRevision: string,
  ): Promise<WorkspaceWriteResponse>;
  createFile(
    input: WorkspaceCreateFileRequest,
  ): Promise<WorkspaceWriteResponse>;
  uploadFile(
    destinationPath: string,
    file: File,
  ): Promise<WorkspaceUploadFileResponse>;
  renameFile(path: string, newName: string): Promise<WorkspaceRenameResponse>;
  moveFile(
    sourcePath: string,
    destinationDir: string,
  ): Promise<WorkspaceMoveResponse>;
  deleteFile(
    path: string,
    expectedRevision?: string,
  ): Promise<WorkspaceDeleteResponse>;
  rawUrl(path: string): string;
  downloadUrl(path: string): string;
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

export const httpWorkspaceApi: WorkspaceApi = {
  loadTree() {
    return requestJson<WorkspaceTreeResponse>("/api/workspace/tree");
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
  loadFile(path) {
    const query = new URLSearchParams({ path });
    return requestJson<WorkspaceFile>(`/api/workspace/file?${query}`);
  },
  loadFileMetadata(path) {
    const query = new URLSearchParams({ path });
    return requestJson<WorkspaceFileMetadata>(
      `/api/workspace/file-info?${query}`,
    );
  },
  saveFile(path, content, expectedRevision) {
    return requestJson<WorkspaceWriteResponse>("/api/workspace/file", {
      body: JSON.stringify({
        content,
        expected_revision: expectedRevision,
        path,
      }),
      method: "PUT",
    });
  },
  createFile(input) {
    return requestJson<WorkspaceWriteResponse>("/api/workspace/file/create", {
      body: JSON.stringify(input),
      method: "POST",
    });
  },
  uploadFile(destinationPath, file) {
    const formData = new FormData();
    formData.set("path", destinationPath);
    formData.set("file", file);
    return requestJson<WorkspaceUploadFileResponse>(
      "/api/workspace/file/upload",
      {
        body: formData,
        method: "POST",
      },
    );
  },
  renameFile(path, newName) {
    return requestJson<WorkspaceRenameResponse>("/api/workspace/file/rename", {
      body: JSON.stringify({
        new_name: newName,
        path,
      }),
      method: "POST",
    });
  },
  moveFile(sourcePath, destinationDir) {
    return requestJson<WorkspaceMoveResponse>("/api/workspace/file/move", {
      body: JSON.stringify({
        destination_dir: destinationDir,
        path: sourcePath,
      }),
      method: "POST",
    });
  },
  deleteFile(path, expectedRevision) {
    return requestJson<WorkspaceDeleteResponse>("/api/workspace/file", {
      body: JSON.stringify({
        ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
        path,
      }),
      method: "DELETE",
    });
  },
  rawUrl(path) {
    return `/api/workspace/raw?${new URLSearchParams({ path })}`;
  },
  downloadUrl(path) {
    return `/api/workspace/download?${new URLSearchParams({ path })}`;
  },
};
