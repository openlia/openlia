import { useId, useState } from "react";
import type { CalendarEvent, CalendarSource, LogicalEvent } from "./types";

function scheduleLabel(event: LogicalEvent | CalendarEvent): string | null {
  const schedule =
    "rawEvent" in event ? event.rawEvent.schedule : event.schedule;
  if (!schedule?.isRecurring) return null;

  const parts = [schedule.dateSpec || "daily"];
  if (schedule.repeat) parts.push(schedule.repeat);
  if (schedule.advanceToken) parts.push(schedule.advanceToken);
  if (schedule.backToken) parts.push(schedule.backToken);
  if (schedule.endKeyword && schedule.endDate) {
    parts.push(schedule.endKeyword, schedule.endDate);
  }
  if (schedule.fromDate) parts.push("FROM", schedule.fromDate);
  return parts.join(" ");
}

export interface EventModalProps {
  event: LogicalEvent | CalendarEvent | null;
  mode: "view" | "edit" | "create";
  presetDate?: string | undefined;
  presetTime?: string | undefined;
  sources: CalendarSource[];
  currentFilePath: string;
  onClose: () => void;
  onSave: (
    event: Partial<CalendarEvent>,
    targetSource: string,
  ) => void | Promise<void>;
  onDelete?: ((event: CalendarEvent) => void | Promise<void>) | undefined;
  onNavigateLink?: ((path: string) => void) | undefined;
}

export function EventModal({
  event,
  mode: initialMode,
  presetDate,
  presetTime,
  sources,
  currentFilePath,
  onClose,
  onSave,
  onDelete,
  onNavigateLink,
}: EventModalProps) {
  const [mode, setMode] = useState<"view" | "edit" | "create">(initialMode);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Field IDs
  const summaryId = useId();
  const startDateId = useId();
  const endDateId = useId();
  const isRangeId = useId();
  const allDayId = useId();
  const timeId = useId();
  const durationId = useId();
  const sourceId = useId();
  const callUrlId = useId();
  const locationId = useId();
  const mapUrlId = useId();
  const attendeesId = useId();
  const descriptionId = useId();
  const noteId = useId();
  const tagsId = useId();

  // Helper getters from either LogicalEvent or CalendarEvent
  const eventTitle = event
    ? "title" in event
      ? event.title
      : event.summary
    : "";
  const initialStartDate = event
    ? "startDate" in event
      ? event.startDate
      : event.date
    : presetDate || new Date().toISOString().slice(0, 10);
  const initialEndDate = event
    ? "endDate" in event && event.endDate
      ? event.endDate
      : initialStartDate
    : initialStartDate;
  const initialIsRange = Boolean(
    event &&
      (("isRange" in event && event.isRange) ||
        ("endDate" in event &&
          event.endDate &&
          event.endDate !== initialStartDate)),
  );
  const initialAllDay = event
    ? "allDay" in event
      ? event.allDay
      : !event.time
    : !presetTime;

  // Form state
  const [summary, setSummary] = useState(eventTitle);
  const [startDate, setStartDate] = useState(initialStartDate);
  const [endDate, setEndDate] = useState(initialEndDate);
  const [isRange, setIsRange] = useState(initialIsRange);
  const [allDay, setAllDay] = useState(initialAllDay);
  const [time, setTime] = useState(event?.time || presetTime || "");
  const [duration, setDuration] = useState(event?.duration?.toString() || "60");
  const [location, setLocation] = useState(event?.location || "");
  const [mapUrl, setMapUrl] = useState(event?.mapUrl || "");
  const [callUrl, setCallUrl] = useState(event?.callUrl || "");
  const [attendees, setAttendees] = useState(
    event?.attendees?.join(", ") || "",
  );
  const [description, setDescription] = useState(event?.description || "");
  const [note, setNote] = useState(event?.note || "");
  const [tags, setTags] = useState(event?.tags?.join(" ") || "");
  const [targetSource, setTargetSource] = useState(
    event?.sourceFile || currentFilePath,
  );

  const isRecurring = Boolean(
    event &&
      ("isRecurring" in event
        ? event.isRecurring
        : event.schedule?.isRecurring),
  );

  const sourceRule = event
    ? "sourceRule" in event
      ? event.sourceRule
      : event.rawStatement
    : undefined;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!summary.trim() || isSaving) return;

    if (isRange && endDate < startDate) {
      setSaveError("End date must be greater than or equal to start date.");
      return;
    }

    const attendeeList = attendees
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);

    const tagList = tags
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const durMins = allDay ? 0 : parseInt(duration, 10) || (time ? 60 : 0);

    setIsSaving(true);
    setSaveError(null);
    try {
      await onSave(
        {
          summary: summary.trim(),
          date: startDate.trim(),
          endDate: isRange && endDate >= startDate ? endDate.trim() : undefined,
          time: allDay ? undefined : time.trim() || undefined,
          duration: durMins,
          location: location.trim() || undefined,
          mapUrl: mapUrl.trim() || undefined,
          callUrl: callUrl.trim() || undefined,
          attendees: attendeeList,
          description: description.trim() || undefined,
          note: note.trim() || undefined,
          tags: tagList,
        },
        targetSource,
      );
      onClose();
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "The calendar event could not be saved.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!event || !onDelete || isSaving) return;
    if (!confirm(`Delete event "${eventTitle}"?`)) return;

    setIsSaving(true);
    setSaveError(null);
    try {
      const raw = "rawEvent" in event ? event.rawEvent : event;
      await onDelete(raw);
      onClose();
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "The calendar event could not be deleted.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="modal modal-open" role="dialog" aria-modal="true">
      <div className="modal-box max-w-xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-base-content/10 pb-3">
          <div className="flex items-center gap-2 truncate">
            <h3 className="text-lg font-bold truncate">
              {mode === "create"
                ? "New Calendar Event"
                : mode === "edit"
                  ? "Edit Event"
                  : eventTitle}
            </h3>
            {event?.sourceFile && mode === "view" && (
              <span className="badge badge-sm badge-outline shrink-0 font-mono text-[10px]">
                {event.sourceFile.split("/").pop()}
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-circle"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {/* View Mode */}
        {mode === "view" && event && (
          <div className="py-4 flex flex-col gap-3 text-sm">
            {/* Date and Time / Range */}
            <div className="flex items-center gap-2 text-base-content/80 flex-wrap">
              <span className="font-semibold text-base-content">📅 Date:</span>
              {"startDate" in event && event.isRange ? (
                <span>
                  <strong>{event.startDate}</strong> to{" "}
                  <strong>{event.endDate}</strong>{" "}
                  <span className="badge badge-sm badge-ghost ml-1">
                    {event.durationDays} days
                  </span>
                </span>
              ) : (
                <span>
                  {"startDate" in event ? event.startDate : event.date}
                </span>
              )}

              {event.time && (
                <>
                  <span className="ml-1">
                    at <strong className="font-mono">{event.time}</strong>
                  </span>
                  {event.duration > 0 && (
                    <span className="badge badge-sm badge-ghost">
                      {event.duration} min
                    </span>
                  )}
                </>
              )}

              {"allDay" in event && event.allDay && (
                <span className="badge badge-sm badge-neutral">all day</span>
              )}
            </div>

            {/* Tags */}
            {event.tags.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-semibold text-xs text-base-content/70">
                  Tags:
                </span>
                {event.tags.map((t) => (
                  <span key={t} className="badge badge-sm badge-primary">
                    #{t}
                  </span>
                ))}
              </div>
            )}

            {/* Recurring schedule note */}
            {scheduleLabel(event) && (
              <div className="rounded-md border border-primary/20 bg-primary/5 p-2 text-xs">
                <div className="font-semibold text-primary">
                  Recurring series
                </div>
                <code className="mt-1 block break-words text-[11px]">
                  {scheduleLabel(event)}
                </code>
                <div className="mt-1 text-base-content/60">
                  Edits apply to the full Remind rule, not only this occurrence.
                </div>
              </div>
            )}

            {event.unsupportedClauses &&
              event.unsupportedClauses.length > 0 && (
                <div className="alert alert-warning py-2 text-xs">
                  Preview limitations: {event.unsupportedClauses.join(", ")}.
                </div>
              )}

            {/* Video Call Button */}
            {event.callUrl && (
              <div className="flex items-center gap-3 rounded-lg bg-primary/10 p-2.5 border border-primary/20">
                <span className="text-lg">📹</span>
                <div className="flex-1 truncate">
                  <div className="font-semibold text-primary">
                    Video Conference
                  </div>
                  <div className="text-xs text-base-content/70 truncate font-mono">
                    {event.callUrl}
                  </div>
                </div>
                <a
                  href={event.callUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-primary btn-sm shadow-xs"
                >
                  Join Meeting
                </a>
              </div>
            )}

            {/* Location & Map */}
            {(event.location || event.mapUrl) && (
              <div className="flex items-start gap-2 text-base-content/80">
                <span className="font-semibold text-base-content shrink-0">
                  📍 Location:
                </span>
                <div className="flex-1">
                  <span>{event.location || "Location link"}</span>
                  {event.mapUrl && (
                    <a
                      href={event.mapUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 link link-primary text-xs"
                    >
                      (Open Map)
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Attendees */}
            {event.attendees.length > 0 && (
              <div className="flex items-start gap-2">
                <span className="font-semibold text-base-content shrink-0">
                  👥 Attendees:
                </span>
                <div className="flex flex-wrap gap-1">
                  {event.attendees.map((att) => (
                    <span key={att} className="badge badge-sm badge-outline">
                      {att}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Description */}
            {event.description && (
              <div className="flex flex-col gap-1 rounded-md bg-base-200/50 p-2.5">
                <span className="font-semibold text-xs text-base-content/70">
                  Description / Agenda:
                </span>
                <p className="whitespace-pre-wrap text-xs text-base-content leading-relaxed">
                  {event.description}
                </p>
              </div>
            )}

            {/* Companion Markdown Note */}
            {event.note && (
              <div className="flex items-center justify-between rounded-lg bg-base-200/60 p-2 border border-base-content/10">
                <div className="flex items-center gap-2 truncate">
                  <span>📝</span>
                  <span className="text-xs font-medium text-base-content truncate">
                    Companion Note:{" "}
                    <code className="text-xs">{event.note}</code>
                  </span>
                </div>
                {onNavigateLink && (
                  <button
                    type="button"
                    className="btn btn-xs btn-outline btn-primary shrink-0"
                    onClick={() => {
                      onClose();
                      if (event.note) {
                        onNavigateLink(event.note);
                      }
                    }}
                  >
                    Open Note
                  </button>
                )}
              </div>
            )}

            {/* Raw Remind Statement / Source Rule */}
            {sourceRule && (
              <details className="collapse collapse-arrow bg-base-200/30 border border-base-content/10 rounded-box text-xs">
                <summary className="collapse-title font-mono text-[11px] py-1.5 min-h-0 text-base-content/70 font-semibold">
                  Source Remind Rule
                </summary>
                <div className="collapse-content">
                  <pre className="overflow-x-auto font-mono text-[11px] text-base-content/90 whitespace-pre-wrap">
                    {sourceRule}
                  </pre>
                </div>
              </details>
            )}

            {/* View Actions */}
            {saveError && (
              <div className="alert alert-error py-2 text-xs" role="alert">
                {saveError}
              </div>
            )}
            <div className="modal-action border-t border-base-content/10 pt-3 flex items-center justify-between">
              {onDelete && (
                <button
                  type="button"
                  className="btn btn-sm btn-error btn-outline"
                  disabled={isSaving}
                  onClick={() => void handleDelete()}
                >
                  Delete Event
                </button>
              )}
              <div className="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  onClick={() => setMode("edit")}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={onClose}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Edit / Create Form */}
        {(mode === "create" || mode === "edit") && (
          <form
            onSubmit={handleSubmit}
            className="py-4 flex flex-col gap-3 text-xs"
          >
            {/* Summary */}
            <div className="form-control">
              <label className="label py-1" htmlFor={summaryId}>
                <span className="label-text font-semibold">Event Title *</span>
              </label>
              <input
                id={summaryId}
                type="text"
                className="input input-sm input-bordered w-full"
                placeholder="e.g. Sprint Planning, Team Standup"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                required
              />
            </div>

            {/* Range and All-day Toggles */}
            <div className="flex items-center gap-4 py-1">
              <label
                htmlFor={isRangeId}
                className="flex items-center gap-2 cursor-pointer"
              >
                <input
                  id={isRangeId}
                  type="checkbox"
                  className="checkbox checkbox-xs checkbox-primary"
                  checked={isRange}
                  disabled={isRecurring}
                  onChange={(e) => {
                    setIsRange(e.target.checked);
                    if (e.target.checked && endDate < startDate) {
                      setEndDate(startDate);
                    }
                  }}
                />
                <span className="text-xs font-semibold">
                  Multi-day Date Range (THROUGH)
                </span>
              </label>

              <label
                htmlFor={allDayId}
                className="flex items-center gap-2 cursor-pointer"
              >
                <input
                  id={allDayId}
                  type="checkbox"
                  className="checkbox checkbox-xs"
                  checked={allDay}
                  onChange={(e) => setAllDay(e.target.checked)}
                />
                <span className="text-xs">All-day event</span>
              </label>
            </div>

            {/* Date Pickers */}
            <div className="grid grid-cols-2 gap-2">
              <div className="form-control">
                <label className="label py-1" htmlFor={startDateId}>
                  <span className="label-text font-semibold">
                    {isRange ? "Start Date *" : "Date *"}
                  </span>
                </label>
                <input
                  id={startDateId}
                  type="date"
                  className="input input-sm input-bordered w-full font-mono"
                  value={startDate}
                  disabled={isRecurring}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    if (isRange && endDate < e.target.value) {
                      setEndDate(e.target.value);
                    }
                  }}
                  required
                />
              </div>

              {isRange && (
                <div className="form-control">
                  <label className="label py-1" htmlFor={endDateId}>
                    <span className="label-text font-semibold">
                      End Date (Inclusive) *
                    </span>
                  </label>
                  <input
                    id={endDateId}
                    type="date"
                    min={startDate}
                    className="input input-sm input-bordered w-full font-mono"
                    value={endDate}
                    disabled={isRecurring}
                    onChange={(e) => setEndDate(e.target.value)}
                    required
                  />
                </div>
              )}
            </div>

            {/* Time & Duration (if not all day) */}
            {!allDay && (
              <div className="grid grid-cols-2 gap-2">
                <div className="form-control">
                  <label className="label py-1" htmlFor={timeId}>
                    <span className="label-text">Start Time</span>
                  </label>
                  <input
                    id={timeId}
                    type="time"
                    className="input input-sm input-bordered w-full font-mono"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  />
                </div>

                <div className="form-control">
                  <label className="label py-1" htmlFor={durationId}>
                    <span className="label-text">Duration (minutes)</span>
                  </label>
                  <input
                    id={durationId}
                    type="number"
                    min="0"
                    step="5"
                    className="input input-sm input-bordered w-full font-mono"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                  />
                </div>
              </div>
            )}

            {isRecurring && (
              <div className="text-[11px] text-base-content/60">
                This is a recurring occurrence. Dates are read-only; saving
                changes updates the recurring series rule.
              </div>
            )}

            {/* Tags */}
            <div className="form-control">
              <label className="label py-1" htmlFor={tagsId}>
                <span className="label-text font-semibold">
                  Tags (space-separated)
                </span>
              </label>
              <input
                id={tagsId}
                type="text"
                className="input input-sm input-bordered w-full font-mono"
                placeholder="holiday school lina"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
            </div>

            {/* Attendees */}
            <div className="form-control">
              <label className="label py-1" htmlFor={attendeesId}>
                <span className="label-text">
                  Attendees (comma-separated names or emails)
                </span>
              </label>
              <input
                id={attendeesId}
                type="text"
                className="input input-sm input-bordered w-full"
                placeholder="Alice, Bob <bob@example.com>"
                value={attendees}
                onChange={(e) => setAttendees(e.target.value)}
              />
            </div>

            {/* Calendar Source */}
            {mode === "create" && sources.length > 1 && (
              <div className="form-control">
                <label className="label py-1" htmlFor={sourceId}>
                  <span className="label-text font-semibold">
                    Target Calendar
                  </span>
                </label>
                <select
                  id={sourceId}
                  className="select select-sm select-bordered w-full"
                  value={targetSource}
                  onChange={(e) => setTargetSource(e.target.value)}
                >
                  {sources.map((source) => (
                    <option key={source.path} value={source.path}>
                      {source.name} ({source.path})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Video Call URL */}
            <div className="form-control">
              <label className="label py-1" htmlFor={callUrlId}>
                <span className="label-text">
                  Video Link (Google Meet, Zoom)
                </span>
              </label>
              <input
                id={callUrlId}
                type="url"
                className="input input-sm input-bordered w-full font-mono"
                placeholder="https://meet.google.com/..."
                value={callUrl}
                onChange={(e) => setCallUrl(e.target.value)}
              />
            </div>

            {/* Location & Map */}
            <div className="grid grid-cols-2 gap-2">
              <div className="form-control">
                <label className="label py-1" htmlFor={locationId}>
                  <span className="label-text">Location</span>
                </label>
                <input
                  id={locationId}
                  type="text"
                  className="input input-sm input-bordered w-full"
                  placeholder="e.g. 123 Market St, Room 4"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                />
              </div>

              <div className="form-control">
                <label className="label py-1" htmlFor={mapUrlId}>
                  <span className="label-text">Map Link</span>
                </label>
                <input
                  id={mapUrlId}
                  type="url"
                  className="input input-sm input-bordered w-full font-mono"
                  placeholder="https://maps.google.com/?q=..."
                  value={mapUrl}
                  onChange={(e) => setMapUrl(e.target.value)}
                />
              </div>
            </div>

            {/* Description */}
            <div className="form-control">
              <label className="label py-1" htmlFor={descriptionId}>
                <span className="label-text">Description / Agenda</span>
              </label>
              <textarea
                id={descriptionId}
                rows={2}
                className="textarea textarea-sm textarea-bordered w-full leading-relaxed"
                placeholder="Meeting agenda, details, or notes..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {/* Companion Note Path */}
            <div className="form-control">
              <label className="label py-1" htmlFor={noteId}>
                <span className="label-text">Companion Markdown Note Path</span>
              </label>
              <input
                id={noteId}
                type="text"
                className="input input-sm input-bordered w-full font-mono"
                placeholder="calendar/2026-10-15-meeting.md"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            {/* Error banner */}
            {saveError && (
              <div className="alert alert-error py-2 text-xs" role="alert">
                {saveError}
              </div>
            )}

            {/* Form Actions */}
            <div className="modal-action border-t border-base-content/10 pt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={onClose}
                disabled={isSaving}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={isSaving}
              >
                {isSaving
                  ? "Saving..."
                  : mode === "create"
                    ? "Add Event"
                    : "Save Changes"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
