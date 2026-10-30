import { type ReactNode, useEffect, useId, useState } from "react";
import {
  type CalendarDisplayEvent,
  validTimezone,
} from "../../../shared/calendar";
import { useOpenLiaOpenUI } from "../context";
import { CalendarEventDetails } from "./CalendarEventDetails";
import { CalendarContext, type CalendarContextValue } from "./context";

/** Shared interactive shell; only source-backed controllers supply write actions. */
export function CalendarPresentation({
  value,
  onTimezoneChange,
  selected,
  onClose,
  description,
  actions,
  error,
  children,
}: {
  value: CalendarContextValue;
  onTimezoneChange: (timezone: string) => void;
  selected: CalendarDisplayEvent | null;
  onClose: () => void;
  description: string;
  actions?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  const { onOpenRecord } = useOpenLiaOpenUI();
  const timezoneId = useId();
  const [timezoneInput, setTimezoneInput] = useState(value.timezone);
  useEffect(() => setTimezoneInput(value.timezone), [value.timezone]);
  return (
    <CalendarContext.Provider value={value}>
      <section className="space-y-4" aria-label="Calendar workspace">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Calendar</h2>
            <p className="text-xs opacity-70">{description}</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={timezoneId} className="block text-xs">
                Display timezone
              </label>
              <input
                id={timezoneId}
                className="input input-bordered input-sm"
                value={timezoneInput}
                onChange={(event) => setTimezoneInput(event.target.value)}
                onBlur={() => {
                  if (validTimezone(timezoneInput))
                    onTimezoneChange(timezoneInput);
                }}
                aria-invalid={!validTimezone(timezoneInput)}
              />
            </div>
            {actions}
          </div>
        </header>
        {!validTimezone(timezoneInput) && (
          <p role="alert" className="text-error text-xs">
            Enter a valid IANA timezone, for example Europe/London.
          </p>
        )}
        {value.loading && (
          <p role="status" className="text-sm">
            Loading calendar…
          </p>
        )}
        {error && (
          <p role="alert" className="text-error text-sm">
            {error}
          </p>
        )}
        {children}
        {selected && (
          <CalendarEventDetails
            event={selected}
            timezone={value.timezone}
            onClose={onClose}
            onOpenFile={onOpenRecord}
          />
        )}
      </section>
    </CalendarContext.Provider>
  );
}
