import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceRoute } from "../-WorkspaceRoute";

export const Route = createFileRoute("/skills/")({
  component: WorkspaceRoute,
});
