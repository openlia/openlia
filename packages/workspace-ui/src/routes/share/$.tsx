import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceRoute } from "../-WorkspaceRoute";

export const Route = createFileRoute("/share/$")({
  head: () => ({
    meta: [
      {
        name: "robots",
        content: "noindex, nofollow, noarchive",
      },
    ],
  }),
  component: WorkspaceRoute,
});
