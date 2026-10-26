export interface CheckpointFile {
  path: string;
  oid: string | null;
  mode: string | null;
  diff: string;
}

export interface CheckpointProposal {
  id: string;
  revision: number;
  snapshot_id: string;
  base_head: string;
  status: "pending" | "publishing" | "applied" | "dismissed";
  stale?: boolean;
  created_at: string;
  updated_at: string;
  session_id: string | null;
  commits: { message: string; rationale: string; files: string[] }[];
  files: CheckpointFile[];
  excluded: string[];
  exclusion_reasons?: Record<string, string>;
  hashes: string[];
}
