import { createContext, useContext } from "react";
import type { CalendarDisplayEvent } from "../../../shared/calendar";

export interface CalendarContextValue {
  events: CalendarDisplayEvent[];
  date: string;
  timezone: string;
  loading: boolean;
  navigate: (date: string) => void;
  select: (event: CalendarDisplayEvent) => void;
}

export const CalendarContext = createContext<CalendarContextValue | null>(null);

export function useCalendar() {
  return useContext(CalendarContext);
}
