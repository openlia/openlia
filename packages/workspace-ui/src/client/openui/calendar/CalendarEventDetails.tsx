import {
  type CalendarDisplayEvent,
  dateInZone,
  timeInZone,
} from "../../../shared/calendar";

export function CalendarEventDetails({
  event,
  timezone,
  onClose,
  onOpenFile,
}: {
  event: CalendarDisplayEvent;
  timezone: string;
  onClose: () => void;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const format = (value: string) =>
    event.allDay
      ? value
      : new Intl.DateTimeFormat("en-GB", {
          timeZone: timezone,
          dateStyle: "full",
          timeStyle: "long",
        }).format(new Date(value));
  return (
    <dialog
      ref={dialog}
      className="modal backdrop:bg-black/70"
      aria-label="Appointment details dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <section
        className="modal-box max-w-2xl rounded-xl border border-primary/30 bg-base-100 p-4 space-y-3"
        aria-label="Appointment details"
      >
        <header className="flex justify-between gap-3">
          <h3 className="font-semibold">{event.title}</h3>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close details
          </button>
        </header>
        <dl className="text-sm space-y-2">
          <div>
            <dt className="font-medium">Start</dt>
            <dd>{format(event.start)}</dd>
          </div>
          <div>
            <dt className="font-medium">
              End{event.allDay ? " (exclusive)" : ""}
            </dt>
            <dd>{format(event.end)}</dd>
          </div>
          <div>
            <dt className="font-medium">Display timezone</dt>
            <dd>{timezone}</dd>
          </div>
          {!event.allDay && (
            <div>
              <dt className="font-medium">Appointment timezone</dt>
              <dd>
                {event.timezone} · {dateInZone(event.start, event.timezone)}{" "}
                {timeInZone(event.start, event.timezone)} –{" "}
                {dateInZone(event.end, event.timezone)}{" "}
                {timeInZone(event.end, event.timezone)}
              </dd>
            </div>
          )}
          <div>
            <dt className="font-medium">Agenda</dt>
            <dd className="whitespace-pre-wrap">
              {event.agenda || "No agenda"}
            </dd>
          </div>
          <div>
            <dt className="font-medium">Attendees</dt>
            <dd>{event.attendees?.join(", ") || "None"}</dd>
          </div>
          {event.location && (
            <div>
              <dt className="font-medium">Location</dt>
              <dd>{event.location}</dd>
            </div>
          )}
          <div>
            <dt className="font-medium">Notifications</dt>
            <dd>
              {!("notifications" in event)
                ? "Off; inline calendars do not deliver notifications"
                : event.notifications === "off"
                  ? "Off (NOQUEUE)"
                  : "Defined by calendar source; this UI does not deliver notifications"}
            </dd>
          </div>
          <div>
            <dt className="font-medium">Invitations</dt>
            <dd>No invitations sent by this UI</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          {"notePath" in event && event.notePath && onOpenFile && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onOpenFile(event.notePath as string)}
            >
              Open event note
            </button>
          )}
          {"sourcePath" in event && onOpenFile && (
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => onOpenFile(event.sourcePath)}
            >
              Open calendar source
            </button>
          )}
        </div>
        {"sourcePath" in event && (
          <p className="text-xs opacity-60">
            Source: {event.sourcePath}:{event.sourceLine}
          </p>
        )}
      </section>
    </dialog>
  );
}

import { useEffect, useRef } from "react";
