import { useEffect, useId, useRef, useState } from "react";
import {
  type CalendarCreateRequest,
  validTimezone,
  wallTimeToInstant,
} from "../../../shared/calendar";

export function CalendarEventEditor({
  date,
  timezone: defaultTimezone,
  source,
  revision,
  onSave,
  onCancel,
}: {
  date: string;
  timezone: string;
  source: string;
  revision: string;
  onSave: (event: CalendarCreateRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState(`${date}T09:00`);
  const [end, setEnd] = useState(`${date}T10:00`);
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [agenda, setAgenda] = useState("");
  const [attendees, setAttendees] = useState("");
  const [location, setLocation] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [requestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    dialog.current?.showModal?.();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="modal backdrop:bg-black/70"
      aria-labelledby={`${id}-heading`}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onCancel();
      }}
    >
      <form
        className="modal-box max-w-2xl rounded-xl border border-primary/30 bg-base-100 p-4 space-y-3"
        aria-label="New appointment form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (savingRef.current) return;
          setError("");
          if (!validTimezone(timezone)) {
            setError("Enter a valid IANA timezone.");
            return;
          }
          let startsAt: string;
          let endsAt: string;
          try {
            startsAt = wallTimeToInstant(start, timezone);
            endsAt = wallTimeToInstant(end, timezone);
          } catch (caught) {
            setError(
              caught instanceof Error ? caught.message : "Invalid date/time.",
            );
            return;
          }
          if (Date.parse(endsAt) <= Date.parse(startsAt)) {
            setError("End time must be after start time.");
            return;
          }
          savingRef.current = true;
          setSaving(true);
          try {
            await onSave({
              source,
              expectedRevision: revision,
              requestId,
              title: title.trim(),
              start: startsAt,
              end: endsAt,
              timezone,
              agenda,
              attendees: attendees
                .split("\n")
                .map((name) => name.trim())
                .filter(Boolean),
              location,
              notifications: "off",
              invitations: "off",
            });
          } catch (caught) {
            setError(
              caught instanceof Error
                ? caught.message
                : "Appointment could not be saved.",
            );
          } finally {
            savingRef.current = false;
            setSaving(false);
          }
        }}
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 id={`${id}-heading`} className="text-lg font-semibold">
              New appointment
            </h2>
            <p className="text-xs opacity-70">
              Draft only. Nothing is written until you choose Save appointment.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close editor"
            title="Close (Esc)"
            className="btn btn-ghost btn-sm btn-circle shrink-0 text-base-content/70 hover:text-base-content"
            disabled={saving}
            onClick={onCancel}
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                d="M6 18L18 6M6 6l12 12"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </header>
        {error && (
          <p role="alert" className="text-error text-sm">
            {error}
          </p>
        )}
        <fieldset disabled={saving} className="space-y-3">
          <label className="block text-sm">
            Title
            <input
              className="input input-bordered w-full"
              required
              maxLength={300}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block text-sm">
              Start
              <input
                className="input input-bordered w-full"
                required
                type="datetime-local"
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              End
              <input
                className="input input-bordered w-full"
                required
                type="datetime-local"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
              />
            </label>
          </div>
          <label className="block text-sm">
            Appointment timezone
            <input
              className="input input-bordered w-full"
              required
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              placeholder="Asia/Ho_Chi_Minh"
            />
          </label>
          <label className="block text-sm">
            Agenda
            <textarea
              className="textarea textarea-bordered w-full"
              maxLength={10000}
              value={agenda}
              onChange={(event) => setAgenda(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            Attendees (one per line)
            <textarea
              className="textarea textarea-bordered w-full"
              value={attendees}
              onChange={(event) => setAttendees(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            Location
            <input
              className="input input-bordered w-full"
              maxLength={1000}
              value={location}
              onChange={(event) => setLocation(event.target.value)}
            />
          </label>
          <div className="rounded-lg bg-base-200 p-3 text-sm space-y-2">
            <label className="flex gap-2 items-center">
              <input type="checkbox" checked={false} disabled readOnly />
              Notifications — off (delivery unavailable)
            </label>
            <label className="flex gap-2 items-center">
              <input type="checkbox" checked={false} disabled readOnly />
              Send invitations — off (delivery unavailable)
            </label>
            <p className="text-xs opacity-70">
              Saves a local Remind entry with NOQUEUE. Attendees are metadata
              only.
            </p>
          </div>
        </fieldset>
        <p className="text-xs break-all">Save to: {source}</p>
        <div className="modal-action">
          <button
            type="button"
            className="btn btn-sm"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={saving || !title.trim()}
          >
            {saving ? "Saving…" : "Save appointment"}
          </button>
        </div>
      </form>
      <div className="modal-backdrop">
        <button
          type="button"
          aria-label="Close new appointment backdrop"
          disabled={saving}
          onClick={onCancel}
        >
          Close
        </button>
      </div>
    </dialog>
  );
}
