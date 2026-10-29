import { openuiLibrary } from "@openuidev/react-ui";
import { normalizeOpenUIProgram } from "../../shared/openui";
import { Calendar } from "./calendar/Calendar";
import { CalendarMonth } from "./calendar/CalendarMonth";
import { CalendarWeek } from "./calendar/CalendarWeek";
import { GanttChart } from "./calendar/GanttChart";
import { ChartPanel } from "./charts/ChartPanel";
import { SankeyDiagram } from "./charts/SankeyDiagram";
import { Finance } from "./finance/Finance";
import { FinanceAccounts } from "./finance/FinanceAccounts";
import { FinanceChart } from "./finance/FinanceChart";
import { FinanceOverview } from "./finance/FinanceOverview";

export { normalizeOpenUIProgram };

export const openliaComponents = [
  ChartPanel,
  SankeyDiagram,
  Finance,
  FinanceAccounts,
  FinanceChart,
  FinanceOverview,
  Calendar,
  CalendarMonth,
  CalendarWeek,
  GanttChart,
];

export const openliaLibrary = openuiLibrary.extend({
  components: { add: openliaComponents },
});
