import { type FSWatcher, watch } from "node:fs";
import { protectedPath } from "../workspace";
import type { MaintainerService } from "./engine";

export class MaintainerWatcher {
  private watcher: FSWatcher | null = null;
  private pendingPaths = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(
    private readonly service: MaintainerService,
    options?: { debounceMs?: number | undefined },
  ) {
    this.debounceMs = options?.debounceMs ?? 300;
  }

  start(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(
        this.service.workspaceRoot,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          const normalized = filename.replaceAll("\\", "/");
          if (
            normalized.startsWith(".") ||
            normalized.includes("/.") ||
            protectedPath(normalized)
          ) {
            return;
          }
          this.pendingPaths.add(normalized);
          this.scheduleFlush();
        },
      );
    } catch {
      // Recursive fs.watch may not be supported on all platforms; explicit write/audit hooks still run
    }
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const batch = [...this.pendingPaths];
      this.pendingPaths.clear();
      if (batch.length > 0) {
        try {
          this.service.validateAndReconcilePaths(batch);
        } catch {}
      }
    }, this.debounceMs);
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {}
      this.watcher = null;
    }
  }
}
