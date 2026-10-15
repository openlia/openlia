import { useId, useState } from "react";
import type { CalendarEvent, CalendarSource } from "./types";

function scheduleLabel(event: CalendarEvent): string | null {
  const schedule = event.schedule;
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
  event: CalendarEvent | null;
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

  // Accessible field IDs
  const summaryId = useId();
  const dateId = useId();
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

  // Form state
  const [summary, setSummary] = useState(event?.summary || "");
  const [date, setDate] = useState(
    event?.date || presetDate || new Date().toISOString().slice(0, 10),
  );
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!summary.trim() || isSaving) return;

    const attendeeList = attendees
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);

    const tagList = tags
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const durMins = parseInt(duration, 10) || (time ? 60 : 0);

    setIsSaving(true);
    setSaveError(null);
    try {
      await onSave(
        {
          summary: summary.trim(),
          date: date.trim(),
          time: time.trim() || undefined,
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
    if (!confirm(`Delete event "${event.summary}"?`)) return;

    setIsSaving(true);
    setSaveError(null);
    try {
      await onDelete(event);
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
                  : event?.summary}
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
            {/* Date and Time */}
            <div className="flex items-center gap-2 text-base-content/80">
              <span className="font-semibold text-base-content">
                📅 Date & Time:
              </span>
              <span>{event.date}</span>
              {event.time && (
                <>
                  <span>
                    at <strong className="font-mono">{event.time}</strong>
                  </span>
                  {event.duration > 0 && (
                    <span className="badge badge-sm badge-ghost">
                      {event.duration} min
                    </span>
                  )}
                </>
              )}
            </div>

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

            {/* Raw REM Statement (collapsible) */}
            {event.rawStatement && (
              <details className="collapse collapse-arrow bg-base-200/30 border border-base-content/10 rounded-box text-xs">
                <summary className="collapse-title font-mono text-[11px] py-1.5 min-h-0 text-base-content/60">
                  Raw Remind statement
                </summary>
                <div className="collapse-content">
                  <pre className="overflow-x-auto font-mono text-[11px] text-base-content/80 whitespace-pre-wrap">
                    {event.rawStatement}
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

            {/* Date, Time, Duration */}
            <div className="grid grid-cols-3 gap-2">
              <div className="form-control">
                <label className="label py-1" htmlFor={dateId}>
                  <span className="label-text font-semibold">Date *</span>
                </label>
                <input
                  id={dateId}
                  type="date"
                  className="input input-sm input-bordered w-full font-mono"
                  value={date}
                  disabled={Boolean(event?.schedule?.isRecurring)}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </div>

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
                  <span className="label-text">Duration (mins)</span>
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
            {event?.schedule?.isRecurring && (
              <div className="text-[11px] text-base-content/60">
                This is a recurring occurrence. The date is read-only; saving
                changes the full series rule.
              </div>
            )}

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

            {/* Attendees */}
            <div className="form-control">
              <label className="label py-1" htmlFor={attendeesId}>
                <span className="label-text">Attendees (comma separated)</span>
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

            {/* Description */}
            <div className="form-control">
              <label className="label py-1" htmlFor={descriptionId}>
                <span className="label-text">Description / Agenda</span>
              </label>
              <textarea
                id={descriptionId}
                className="textarea textarea-bordered textarea-sm w-full h-18"
                placeholder="Meeting agenda, discussion topics..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {/* Companion Markdown Note */}
            <div className="form-control">
              <label className="label py-1" htmlFor={noteId}>
                <span className="label-text">
                  Companion Note (workspace path)
                </span>
              </label>
              <input
                id={noteId}
                type="text"
                className="input input-sm input-bordered w-full font-mono"
                placeholder="calendar/YYYY-MM-DD-meeting.md"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            {/* Tags */}
            <div className="form-control">
              <label className="label py-1" htmlFor={tagsId}>
                <span className="label-text">Tags (space separated)</span>
              </label>
              <input
                id={tagsId}
                type="text"
                className="input input-sm input-bordered w-full font-mono"
                placeholder="meeting sprint 1on1"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
            </div>

            {/* Actions */}
            {saveError && (
              <div className="alert alert-error py-2 text-xs" role="alert">
                {saveError}
              </div>
            )}
            <div className="modal-action border-t border-base-content/10 pt-3 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={isSaving}
                onClick={() => {
                  if (mode === "edit") setMode("view");
                  else onClose();
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-sm btn-primary shadow-xs"
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
      <button
        type="button"
        className="modal-backdrop bg-black/40"
        onClick={onClose}
        aria-label="Close backdrop"
      />
    </div>
  );
}
