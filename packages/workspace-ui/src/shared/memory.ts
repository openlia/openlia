// Reserved document identities: these are not paths inside the workspace.
export const MEMORY_DOCUMENT_PREFIX = "@memories/";
export const MEMORY_FILENAMES = ["USER.md", "MEMORY.md"] as const;
export type MemoryFilename = (typeof MEMORY_FILENAMES)[number];

export function isMemoryDocument(path: string): boolean {
  return path.startsWith(MEMORY_DOCUMENT_PREFIX);
}

export function memoryFilename(path: string): string {
  return path.slice(MEMORY_DOCUMENT_PREFIX.length);
}

export function memoryDocumentPath(name: string): string {
  return `${MEMORY_DOCUMENT_PREFIX}${name}`;
}
