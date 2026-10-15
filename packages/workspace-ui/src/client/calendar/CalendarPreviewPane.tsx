import { useEffect, useMemo, useState } from "react";
import { resolveRelativePath } from "../openliaLinks";
import { CalendarToolbar } from "./CalendarToolbar";
import { EventModal } from "./EventModal";
import { GanttView } from "./GanttView";
import { MonthView } from "./MonthView";
import {
  addEventToFile,
  deleteEventFromFile,
  expandEventsForRange,
  parseRemindFile,
  updateEventInFile,
} from "./remindParser";
import type { CalendarEvent, CalendarSource, CalendarViewMode } from "./types";
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
  const [includedFiles, setIncludedFiles] = useState<
    Map<string, LoadedCalendarFile>
  >(() => new Map());
  const [includesLoading, setIncludesLoading] = useState(false);

  // Modal state
  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    mode: "view" | "edit" | "create";
    event: CalendarEvent | null;
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

  useEffect(() => {
    let cancelled = false;

    async function loadIncludedFiles() {
      if (!onLoadCalendarFile) {
        setIncludedFiles(new Map());
        return;
      }

      setIncludesLoading(true);
      setIncludedFiles(new Map());
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
        setIncludedFiles(loaded);
        setIncludesLoading(false);
      }
    }

    void loadIncludedFiles();
    return () => {
      cancelled = true;
    };
  }, [filePath, onLoadCalendarFile, parsedCurrent.includedFiles]);

  const calendarFiles = useMemo<LoadedCalendarFile[]>(
    () => [
      { path: filePath, content, revision: fileRevision },
      ...includedFiles.values(),
    ],
    [content, filePath, fileRevision, includedFiles],
  );

  const parsedCalendarFiles = useMemo(
    () =>
      calendarFiles.map((file) => ({
        file,
        parsed: parseRemindFile(file.content, file.path),
      })),
    [calendarFiles],
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
      setIncludedFiles((previous) => {
        const next = new Map(previous);
        next.set(path, {
          path,
          content: nextContent,
          revision: result.revision,
        });
        return next;
      });
    }
  };

  // Expand events for the active visible date window
  const visibleExpandedEvents = useMemo(() => {
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
      // Gantt: 35 days window
      startIso = new Date(currentDate.getTime() - 7 * 86400000)
        .toISOString()
        .slice(0, 10);
      endIso = new Date(currentDate.getTime() + 35 * 86400000)
        .toISOString()
        .slice(0, 10);
    }

    return expandEventsForRange(allRawEvents, startIso, endIso);
  }, [allRawEvents, currentDate, viewMode]);

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
          ? updateEventInFile(source.content, modalState.event, eventData)
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
        <div className="min-h-0 min-w-0 flex-1">
          {viewMode === "month" && (
            <MonthView
              currentDate={currentDate}
              events={visibleExpandedEvents}
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
              events={visibleExpandedEvents}
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
              events={visibleExpandedEvents}
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
