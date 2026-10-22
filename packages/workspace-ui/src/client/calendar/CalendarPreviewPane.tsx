import { useEffect, useMemo, useState } from "react";
import { resolveRelativePath } from "../openliaLinks";
import { CalendarToolbar } from "./CalendarToolbar";
import { EventModal } from "./EventModal";
import {
  extractFilterOptions,
  filterLogicalEvents,
  interpretLogicalEvents,
} from "./eventInterpretation";
import { GanttView } from "./GanttView";
import { MonthView } from "./MonthView";
import {
  addEventToFile,
  deleteEventFromFile,
  parseRemindFile,
  updateEventInFile,
} from "./remindParser";
import type {
  CalendarEvent,
  CalendarFilterState,
  CalendarSource,
  CalendarViewMode,
  LogicalEvent,
} from "./types";
import { WeekView } from "./WeekView";

export interface CalendarPreviewPaneProps {
  content: string;
  filePath: string;
  fileRevision: string;
  onSwitchToEdit?: (() => void) | undefined;
  onNavigateLink?: ((path: string) => void) | undefined;
  onLoadCalendarFile?:
    | ((path: string) => Promise<{ content: string; revision: string }>)
    | undefined;
  onSaveCalendarFile?:
    | ((
        path: string,
        content: string,
        expectedRevision: string,
      ) => Promise<{ revision: string }>)
    | undefined;
}

interface LoadedCalendarFile {
  path: string;
  content: string;
  revision: string;
}

interface IncludedFilesState {
  loadKey: string | null;
  files: Map<string, LoadedCalendarFile>;
}

const COLOR_PALETTES = [
  {
    bgClass: "bg-primary/15",
    textClass: "text-primary",
    borderClass: "border-primary/40",
    color: "#3b82f6",
  },
  {
    bgClass: "bg-secondary/15",
    textClass: "text-secondary",
    borderClass: "border-secondary/40",
    color: "#ec4899",
  },
  {
    bgClass: "bg-accent/15",
    textClass: "text-accent",
    borderClass: "border-accent/40",
    color: "#10b981",
  },
  {
    bgClass: "bg-warning/15",
    textClass: "text-warning",
    borderClass: "border-warning/40",
    color: "#f59e0b",
  },
  {
    bgClass: "bg-info/15",
    textClass: "text-info",
    borderClass: "border-info/40",
    color: "#06b6d4",
  },
];

export function CalendarPreviewPane({
  content,
  filePath,
  fileRevision,
  onSwitchToEdit,
  onNavigateLink,
  onLoadCalendarFile,
  onSaveCalendarFile,
}: CalendarPreviewPaneProps) {
  const [viewMode, setViewMode] = useState<CalendarViewMode>("month");
  const [currentDate, setCurrentDate] = useState<Date>(() => new Date());
  const [includedFilesState, setIncludedFilesState] =
    useState<IncludedFilesState>(() => ({
      loadKey: null,
      files: new Map(),
    }));
  const [includesLoading, setIncludesLoading] = useState(false);

  // Filter state
  const [filterState, setFilterState] = useState<CalendarFilterState>({
    enabledSources: new Set(),
    selectedTags: new Set(),
    selectedPeople: new Set(),
    searchQuery: "",
  });

  // Modal state
  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    mode: "view" | "edit" | "create";
    event: LogicalEvent | null;
    presetDate?: string | undefined;
    presetTime?: string | undefined;
  }>({
    isOpen: false,
    mode: "view",
    event: null,
  });

  // Parse current file
  const parsedCurrent = useMemo(() => {
    return parseRemindFile(content, filePath);
  }, [content, filePath]);

  // Included files belong to a specific root file and include list. Keep that
  // identity with the loaded data so a file switch cannot render the previous
  // calendar's files while the new include tree is loading.
  const includeLoadKey = `${filePath}\u0000${parsedCurrent.includedFiles.join(
    "\u0000",
  )}`;

  useEffect(() => {
    let cancelled = false;

    async function loadIncludedFiles() {
      if (!onLoadCalendarFile) {
        setIncludedFilesState({ loadKey: null, files: new Map() });
        return;
      }

      setIncludesLoading(true);
      setIncludedFilesState({ loadKey: null, files: new Map() });
      const loaded = new Map<string, LoadedCalendarFile>();
      const queue: Array<{ includePath: string; fromFile: string }> =
        parsedCurrent.includedFiles.map((includePath) => ({
          includePath,
          fromFile: filePath,
        }));
      const visited = new Set<string>([filePath]);
      let iterations = 0;

      while (queue.length > 0 && iterations < 50) {
        iterations++;
        const item = queue.shift();
        if (!item) break;

        const resolvedPath = resolveRelativePath(
          item.includePath,
          item.fromFile,
        );
        if (visited.has(resolvedPath)) continue;
        visited.add(resolvedPath);

        try {
          const file = await onLoadCalendarFile(resolvedPath);
          if (cancelled) return;

          const loadedFile = { path: resolvedPath, ...file };
          loaded.set(resolvedPath, loadedFile);
          const nested = parseRemindFile(file.content, resolvedPath);
          for (const includePath of nested.includedFiles) {
            queue.push({ includePath, fromFile: resolvedPath });
          }
        } catch {
          // Ignore missing includes while still showing the available calendar.
        }
      }

      if (!cancelled) {
        setIncludedFilesState({ loadKey: includeLoadKey, files: loaded });
        setIncludesLoading(false);
      }
    }

    void loadIncludedFiles();
    return () => {
      cancelled = true;
    };
  }, [
    filePath,
    includeLoadKey,
    onLoadCalendarFile,
    parsedCurrent.includedFiles,
  ]);

  const calendarFiles = useMemo<LoadedCalendarFile[]>(() => {
    const filesByPath = new Map<string, LoadedCalendarFile>();
    filesByPath.set(filePath, {
      path: filePath,
      content,
      revision: fileRevision,
    });

    if (includedFilesState.loadKey === includeLoadKey) {
      for (const file of includedFilesState.files.values()) {
        // The selected file is always the root source. Prefer it if a cyclic
        // or stale include happens to return the same path.
        if (!filesByPath.has(file.path)) filesByPath.set(file.path, file);
      }
    }

    return [...filesByPath.values()];
  }, [content, filePath, fileRevision, includeLoadKey, includedFilesState]);

  const parsedCalendarFiles = useMemo(
    () =>
      calendarFiles.map((file) => ({
        file,
        parsed: parseRemindFile(file.content, file.path),
      })),
    [calendarFiles],
  );

  const parseWarnings = useMemo(
    () => parsedCalendarFiles.flatMap(({ parsed }) => parsed.warnings),
    [parsedCalendarFiles],
  );

  // Build one source per file in the selected calendar's include tree.
  const sources: CalendarSource[] = useMemo(() => {
    return parsedCalendarFiles.map(({ file, parsed }, index) => {
      const palette = COLOR_PALETTES[index % COLOR_PALETTES.length] ?? {
        bgClass: "bg-primary/15",
        textClass: "text-primary",
        borderClass: "border-primary/40",
        color: "#3b82f6",
      };
      const name =
        file.path
          .split("/")
          .pop()
          ?.replace(/\.rem(ind)?$/, "") || file.path;

      return {
        path: file.path,
        name,
        color: palette.color,
        bgClass: palette.bgClass,
        textClass: palette.textClass,
        borderClass: palette.borderClass,
        enabled: true,
        isCurrentFile: file.path === filePath,
        eventCount: parsed.events.length,
      };
    });
  }, [filePath, parsedCalendarFiles]);

  const allRawEvents = useMemo(
    () => parsedCalendarFiles.flatMap(({ parsed }) => parsed.events),
    [parsedCalendarFiles],
  );

  const findCalendarFile = (path: string) => {
    return calendarFiles.find((file) => file.path === path);
  };

  const saveCalendarFile = async (path: string, nextContent: string) => {
    const source = findCalendarFile(path);
    if (!source || !onSaveCalendarFile) {
      throw new Error("Calendar source is not available for saving.");
    }

    const result = await onSaveCalendarFile(path, nextContent, source.revision);

    if (path !== filePath) {
      setIncludedFilesState((previous) => {
        const next = new Map(previous.files);
        next.set(path, {
          path,
          content: nextContent,
          revision: result.revision,
        });
        return { ...previous, files: next };
      });
    }
  };

  // Convert raw events into normalized logical events for the active visible date window
  const interpretedEvents = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    let startIso: string;
    let endIso: string;

    if (viewMode === "month") {
      const first = new Date(Date.UTC(year, month - 1, 20));
      const last = new Date(Date.UTC(year, month + 1, 15));
      startIso = first.toISOString().slice(0, 10);
      endIso = last.toISOString().slice(0, 10);
    } else if (viewMode === "week") {
      const d = new Date(currentDate.getTime());
      let day = d.getDay();
      if (day === 0) day = 7;
      const mon = new Date(d.getTime() - (day - 1) * 86400000);
      const sun = new Date(mon.getTime() + 6 * 86400000);
      startIso = mon.toISOString().slice(0, 10);
      endIso = sun.toISOString().slice(0, 10);
    } else {
      // Gantt: 90 days window to accommodate zoom levels
      startIso = new Date(currentDate.getTime() - 14 * 86400000)
        .toISOString()
        .slice(0, 10);
      endIso = new Date(currentDate.getTime() + 95 * 86400000)
        .toISOString()
        .slice(0, 10);
    }

    return interpretLogicalEvents(allRawEvents, startIso, endIso);
  }, [allRawEvents, currentDate, viewMode]);

  // Extract filter options (tags, attendees) from interpreted events
  const { tags: availableTags, people: availablePeople } = useMemo(() => {
    return extractFilterOptions(interpretedEvents);
  }, [interpretedEvents]);

  // Apply active filters to logical events
  const visibleEvents = useMemo(() => {
    return filterLogicalEvents(interpretedEvents, filterState);
  }, [interpretedEvents, filterState]);

  // Navigation handlers
  const handlePrev = () => {
    setCurrentDate((prev) => {
      const d = new Date(prev);
      if (viewMode === "month") {
        d.setMonth(d.getMonth() - 1);
      } else if (viewMode === "week") {
        d.setDate(d.getDate() - 7);
      } else {
        d.setDate(d.getDate() - 14);
      }
      return d;
    });
  };

  const handleNext = () => {
    setCurrentDate((prev) => {
      const d = new Date(prev);
      if (viewMode === "month") {
        d.setMonth(d.getMonth() + 1);
      } else if (viewMode === "week") {
        d.setDate(d.getDate() + 7);
      } else {
        d.setDate(d.getDate() + 14);
      }
      return d;
    });
  };

  const handleToday = () => {
    setCurrentDate(new Date());
  };

  // Title generation
  const title = useMemo(() => {
    const year = currentDate.getFullYear();
    const monthName = currentDate.toLocaleString("default", { month: "long" });

    if (viewMode === "month" || viewMode === "gantt") {
      return `${monthName} ${year}`;
    }

    // Week title
    const d = new Date(currentDate.getTime());
    let day = d.getDay();
    if (day === 0) day = 7;
    const mon = new Date(d.getTime() - (day - 1) * 86400000);
    const sun = new Date(mon.getTime() + 6 * 86400000);

    const monMonth = mon.toLocaleString("default", { month: "short" });
    const sunMonth = sun.toLocaleString("default", { month: "short" });

    if (monMonth === sunMonth) {
      return `${monMonth} ${mon.getDate()} – ${sun.getDate()}, ${year}`;
    }
    return `${monMonth} ${mon.getDate()} – ${sunMonth} ${sun.getDate()}, ${year}`;
  }, [currentDate, viewMode]);

  // Event modal writes are persisted immediately to the selected source file.
  const handleSaveEvent = async (
    eventData: Partial<CalendarEvent>,
    targetSource: string,
  ) => {
    const sourcePath =
      modalState.mode === "create"
        ? targetSource
        : modalState.event?.sourceFile;
    if (!sourcePath) throw new Error("Calendar source is not available.");

    const source = findCalendarFile(sourcePath);
    if (!source) throw new Error("Calendar source is not available.");

    const updatedContent =
      modalState.mode === "create"
        ? addEventToFile(source.content, eventData)
        : modalState.event
          ? updateEventInFile(
              source.content,
              modalState.event.rawEvent,
              eventData,
            )
          : source.content;

    await saveCalendarFile(sourcePath, updatedContent);
  };

  const handleDeleteEvent = async (event: CalendarEvent) => {
    const source = findCalendarFile(event.sourceFile);
    if (!source) throw new Error("Calendar source is not available.");

    const updatedContent = deleteEventFromFile(source.content, event);
    await saveCalendarFile(event.sourceFile, updatedContent);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-base-100">
      {/* Top Calendar Toolbar */}
      <CalendarToolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        title={title}
        onPrev={handlePrev}
        onNext={handleNext}
        onToday={handleToday}
        onNewEvent={() =>
          setModalState({
            isOpen: true,
            mode: "create",
            event: null,
            presetDate: currentDate.toISOString().slice(0, 10),
          })
        }
        onSwitchToEdit={onSwitchToEdit}
        availableTags={availableTags}
        availablePeople={availablePeople}
        filterState={filterState}
        onFilterChange={setFilterState}
      />

      {/* Active Calendar View */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {includesLoading && (
          <div
            className="shrink-0 border-b border-base-content/10 px-3 py-1 text-xs text-base-content/60"
            role="status"
          >
            Loading included calendars...
          </div>
        )}
        {parseWarnings.length > 0 && (
          <div
            className="shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-base-content"
            role="status"
          >
            <div className="font-semibold">
              Some Remind rules are previewed approximately.
            </div>
            <ul className="mt-1 max-h-24 overflow-y-auto list-disc pl-4">
              {parseWarnings.map((warning) => (
                <li
                  key={`${warning.sourceFile}:${warning.lineNumber}:${warning.message}`}
                >
                  {warning.sourceFile}:{warning.lineNumber} {warning.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="min-h-0 min-w-0 flex-1">
          {viewMode === "month" && (
            <MonthView
              currentDate={currentDate}
              events={visibleEvents}
              sources={sources}
              onSelectEvent={(ev) =>
                setModalState({ isOpen: true, mode: "view", event: ev })
              }
              onNewEventOnDate={(dateIso) =>
                setModalState({
                  isOpen: true,
                  mode: "create",
                  event: null,
                  presetDate: dateIso,
                })
              }
            />
          )}

          {viewMode === "week" && (
            <WeekView
              currentDate={currentDate}
              events={visibleEvents}
              sources={sources}
              onSelectEvent={(ev) =>
                setModalState({ isOpen: true, mode: "view", event: ev })
              }
              onNewEventOnTime={(dateIso, timeStr) =>
                setModalState({
                  isOpen: true,
                  mode: "create",
                  event: null,
                  presetDate: dateIso,
                  presetTime: timeStr,
                })
              }
            />
          )}

          {viewMode === "gantt" && (
            <GanttView
              currentDate={currentDate}
              events={visibleEvents}
              sources={sources}
              onSelectEvent={(ev) =>
                setModalState({ isOpen: true, mode: "view", event: ev })
              }
              onNewEventOnDate={(dateIso) =>
                setModalState({
                  isOpen: true,
                  mode: "create",
                  event: null,
                  presetDate: dateIso,
                })
              }
            />
          )}
        </div>
      </div>

      {/* Event Details & Editor Modal */}
      {modalState.isOpen && (
        <EventModal
          event={modalState.event}
          mode={modalState.mode}
          presetDate={modalState.presetDate}
          presetTime={modalState.presetTime}
          sources={sources}
          currentFilePath={filePath}
          onClose={() =>
            setModalState({ isOpen: false, mode: "view", event: null })
          }
          onSave={handleSaveEvent}
          onDelete={handleDeleteEvent}
          onNavigateLink={onNavigateLink}
        />
      )}
    </div>
  );
}
