export type AuthProvider = "password" | "oidc" | "none";

export interface AuthSessionResponse {
  schema: 1;
  auth_required: boolean;
  authenticated: boolean;
  auth_provider: AuthProvider;
  oidc_issuer?: string | undefined;
  username_required?: boolean | undefined;
}

export interface AuthLoginRequest {
  username?: string | undefined;
  password?: string | undefined;
}

export interface AuthLoginResponse {
  schema: 1;
  ok: true;
  authenticated: true;
}

export interface WorkspaceTreeEntry {
  path: string;
  kind: "file" | "directory";
  size?: number | undefined;
  modified_at?: string | undefined;
  editable?: boolean | undefined;
  missing?: boolean | undefined;
}

export interface WorkspaceTreeResponse {
  schema: 1;
  ok: true;
  entries: WorkspaceTreeEntry[];
  truncated: boolean;
}

export interface WorkspaceFile {
  schema: 1;
  ok: true;
  path: string;
  content: string;
  size: number;
  modified_at: string;
  revision: string;
  editable: boolean;
  missing?: boolean | undefined;
}

export interface WorkspaceFileMetadata {
  schema: 1;
  ok: true;
  path: string;
  size: number;
  modified_at: string;
  revision: string;
  editable: boolean;
}

export interface WorkspaceWriteRequest {
  path: string;
  content: string;
  expected_revision: string;
}

export interface WorkspaceWriteResponse {
  schema: 1;
  ok: true;
  path: string;
  size: number;
  modified_at: string;
  revision: string;
  editable: boolean;
}

export interface WorkspaceCreateFileRequest {
  path: string;
  content?: string | undefined;
}

export interface WorkspaceRenameRequest {
  path: string;
  new_name: string;
}

export interface WorkspaceRenameResponse {
  schema: 1;
  ok: true;
  old_path: string;
  new_path: string;
}

export interface WorkspaceMoveRequest {
  path: string;
  destination_dir: string;
}

export interface WorkspaceMoveResponse {
  schema: 1;
  ok: true;
  old_path: string;
  new_path: string;
}

export interface WorkspaceDeleteRequest {
  path: string;
  expected_revision?: string | undefined;
}

export interface WorkspaceDeleteResponse {
  schema: 1;
  ok: true;
  path: string;
  deleted: true;
}

export interface WorkspaceUploadFileResponse {
  schema: 1;
  ok: true;
  path: string;
  size: number;
  modified_at: string;
  revision: string;
  editable: boolean;
}

export interface WorkspaceErrorResponse {
  schema: 1;
  ok: false;
  error: string;
  message: string;
  current_revision?: string | undefined;
}
