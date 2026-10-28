import { useEffect, useId, useRef, useState } from "react";
import {
  wallTimeToInstant,
  type CalendarCreateRequest,
} from "../../../shared/calendar";

export function CalendarEventEditor({
  date,
  timezone: initialTimezone,
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
  const [requestId] = useState(() => crypto.randomUUID());
  const [title, setTitle] = useState("");
  const [start, setStart] = useState(`${date}T09:00`);
  const [end, setEnd] = useState(`${date}T10:00`);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [agenda, setAgenda] = useState("");
  const [attendees, setAttendees] = useState("");
  const [location, setLocation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-heading`}
      className="modal backdrop:bg-black/70"
      onCancel={(event) => {
        event.preventDefault();
        if (!savingRef.current) onCancel();
      }}
    >
      <form
        className="modal-box max-w-xl bg-base-100 space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (savingRef.current) return;
          setError("");
          try {
            const startsAt = wallTimeToInstant(start, timezone);
            const endsAt = wallTimeToInstant(end, timezone);
            if (Date.parse(endsAt) <= Date.parse(startsAt))
              throw new Error("End must be after start.");
            if (Date.parse(endsAt) - Date.parse(startsAt) > 7 * 86400000)
              throw new Error("Appointments can span at most seven days.");
            savingRef.current = true;
            setSaving(true);
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
        <h2 id={`${id}-heading`} className="text-lg font-semibold">
          New appointment
        </h2>
        <p className="text-xs opacity-70">
          Draft only. Nothing is written until you choose Save appointment.
        </p>
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
              only. No external calendar changes, messages, or jobs are created.
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
    </dialog>
  );
}
