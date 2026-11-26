import { useEffect, useId, useRef } from "react";
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
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal?.();
  }, []);

  const format = (value: string) =>
    event.allDay
      ? value
      : new Intl.DateTimeFormat("en-GB", {
          timeZone: timezone,
          dateStyle: "full",
          timeStyle: "short",
        }).format(new Date(value));

  const attendees = event.attendees ?? [];
  const hasNoteAction = Boolean(
    "notePath" in event && event.notePath && onOpenFile,
  );
  const hasSourceAction = Boolean("sourcePath" in event && onOpenFile);
  const notificationSummary = !("notifications" in event)
    ? "Notifications off (inline calendar)"
    : event.notifications === "off"
      ? "Notifications off (NOQUEUE)"
      : "Notifications defined by source";

  return (
    <dialog
      ref={dialog}
      className="modal backdrop:bg-black/70"
      aria-label="Appointment details dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <section
        className="modal-box max-w-xl overflow-hidden rounded-2xl border border-base-content/15 bg-base-100 p-0 text-base-content shadow-2xl"
        aria-label="Appointment details"
        aria-labelledby={titleId}
      >
        <header className="flex items-start justify-between gap-4 border-b border-base-content/10 px-5 pt-5 pb-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="badge badge-primary badge-xs font-semibold uppercase tracking-wider py-2 px-2">
                {event.allDay ? "All-Day Event" : "Timed Appointment"}
              </span>
              {event.group && (
                <span className="badge badge-ghost badge-xs font-medium py-2 px-2">
                  {event.group}
                </span>
              )}
            </div>
            <h3
              id={titleId}
              className="text-lg font-bold tracking-tight leading-snug break-words"
            >
              {event.title}
            </h3>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <kbd className="kbd kbd-xs bg-base-200 text-[10px] opacity-60 hidden sm:inline-flex">
              Esc
            </kbd>
            <button
              type="button"
              aria-label="Close details"
              title="Close details (Esc)"
              className="btn btn-ghost btn-sm btn-circle text-base-content/70 hover:text-base-content"
              onClick={onClose}
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
          </div>
        </header>

        <div className="px-5 py-4 space-y-4">
          <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-3.5 space-y-3">
            <dl className="grid sm:grid-cols-2 gap-3 text-sm">
              <div className="space-y-0.5">
                <dt className="text-[11px] font-semibold uppercase tracking-wider text-base-content/55">
                  Start
                </dt>
                <dd className="font-medium">{format(event.start)}</dd>
              </div>
              <div className="space-y-0.5">
                <dt className="text-[11px] font-semibold uppercase tracking-wider text-base-content/55">
                  End{event.allDay ? " (exclusive)" : ""}
                </dt>
                <dd className="font-medium">{format(event.end)}</dd>
              </div>
            </dl>
            <div className="border-t border-base-content/10 pt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/70">
              <span>
                <strong className="font-medium text-base-content/85">
                  Display timezone:
                </strong>{" "}
                {timezone}
              </span>
              {!event.allDay && (
                <span>
                  <strong className="font-medium text-base-content/85">
                    Appointment timezone:
                  </strong>{" "}
                  {event.timezone} ({dateInZone(event.start, event.timezone)}{" "}
                  {timeInZone(event.start, event.timezone)} –{" "}
                  {timeInZone(event.end, event.timezone)})
                </span>
              )}
            </div>
          </div>

          {event.location && (
            <div className="flex items-center gap-2 text-sm">
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-base-200 text-base-content/70">
                <svg
                  aria-hidden="true"
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M12 21s-6-5.686-6-10a6 6 0 1112 0c0 4.314-6 10-6 10z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle cx="12" cy="11" r="2" />
                </svg>
              </span>
              <div>
                <span className="text-xs font-medium text-base-content/60 mr-1.5">
                  Location:
                </span>
                <span className="font-medium">{event.location}</span>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-base-content/55">
              Agenda
            </h4>
            <div className="rounded-lg border border-base-content/10 bg-base-200/25 p-3 text-sm whitespace-pre-wrap leading-relaxed">
              {event.agenda ? (
                event.agenda
              ) : (
                <span className="italic text-base-content/50">
                  No agenda notes recorded.
                </span>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-base-content/55">
              Attendees ({attendees.length})
            </h4>
            {attendees.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {attendees.map((person) => (
                  <span
                    key={person}
                    className="inline-flex items-center gap-1.5 rounded-full border border-base-content/15 bg-base-200/60 px-2.5 py-1 text-xs font-medium"
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary"
                    >
                      {person.trim().charAt(0).toUpperCase()}
                    </span>
                    <span>{person}</span>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs italic text-base-content/50">
                No attendees listed.
              </p>
            )}
          </div>
        </div>

        <footer className="border-t border-base-content/10 bg-base-200/30 px-5 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] text-base-content/60 space-y-0.5">
            <p>{notificationSummary} · No invitations sent</p>
            {"sourcePath" in event && (
              <p className="font-mono">
                Source: {event.sourcePath}:{event.sourceLine}
              </p>
            )}
          </div>
          {(hasNoteAction || hasSourceAction) && (
            <div className="flex flex-wrap items-center gap-2">
              {"notePath" in event && event.notePath && onOpenFile && (
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  onClick={() => onOpenFile(event.notePath as string)}
                >
                  Open event note
                </button>
              )}
              {"sourcePath" in event && onOpenFile && (
                <button
                  type="button"
                  className="btn btn-xs btn-outline"
                  onClick={() => onOpenFile(event.sourcePath)}
                >
                  Open calendar source
                </button>
              )}
            </div>
          )}
        </footer>
      </section>
      <div className="modal-backdrop">
        <button
          type="button"
          aria-label="Close appointment details backdrop"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </dialog>
  );
}
