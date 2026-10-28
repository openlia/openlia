import { createContext, useContext } from "react";
import type { CalendarEvent } from "../../../shared/calendar";

export interface CalendarContextValue {
  events: CalendarEvent[];
  date: string;
  timezone: string;
  loading: boolean;
  navigate: (date: string) => void;
  select: (event: CalendarEvent) => void;
}

export const CalendarContext = createContext<CalendarContextValue | null>(null);

export function useCalendar() {
  return useContext(CalendarContext);
}
