import { openuiLibrary } from "@openuidev/react-ui";
import { normalizeOpenUIProgram } from "../../shared/openui";
import { Calendar } from "./calendar/Calendar";
import { CalendarMonth } from "./calendar/CalendarMonth";
import { CalendarWeek } from "./calendar/CalendarWeek";
import { CalendarGantt, GanttChart } from "./calendar/GanttChart";
import { ChartBar, ChartLine, ChartPanel, ChartPie } from "./charts/ChartPanel";
import { ChartSankey, SankeyDiagram } from "./charts/SankeyDiagram";
import { NamedForm } from "./NamedForm";
import { OpenLiaTable } from "./table/Table";

export { normalizeOpenUIProgram };

export const openliaComponents = [
  Calendar,
  CalendarMonth,
  CalendarWeek,
  CalendarGantt,
  GanttChart,
  ChartBar,
  ChartLine,
  ChartPie,
  ChartSankey,
  SankeyDiagram,
  ChartPanel,
];

export const openliaLibrary = openuiLibrary.extend({
  components: {
    add: openliaComponents,
    override: [NamedForm, OpenLiaTable],
  },
});
