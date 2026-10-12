// Re-export split components for backward compatibility
export { CopyLinkButton } from "./components/common/CopyLinkButton";
export { DirtyDraftDialog } from "./components/common/DirtyDraftDialog";
export { DeleteFileDialog } from "./components/common/DeleteFileDialog";
export { WorkspaceHeader } from "./components/layout/WorkspaceHeader";
export {
  MarkdownPreview,
  transformMarkdownUrl,
} from "./components/editor/MarkdownPreview";
export {
  FileNavigator,
  buildTree,
  countFiles,
  nodeMatches,
  matchedFiles,
  type TreeNode,
} from "./features/documents/FileNavigator";
export { DocumentInspector } from "./features/documents/DocumentInspector";
export {
  DocumentPane,
  type WorkspaceView,
} from "./features/documents/DocumentPane";

// Forward re-exports from other existing files
export { ActivitySection } from "./ActivitySection";
export { GitActivitySection } from "./GitActivitySection";
export { IngestionSection } from "./IngestionSection";
export { MoveFileDialog } from "./MoveFileDialog";
export { RenameFileDialog } from "./RenameFileDialog";
export { isJournalPath, isMarkdownPath, isRemindPath } from "./CodeEditor";
