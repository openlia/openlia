import { Renderer } from "@openuidev/react-lang";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  addDecimal,
  amountFor,
  decimalString,
  chartNumber,
} from "../../../shared/charts";
import { createFinanceMock } from "../../financeMock";
import { financeProgram } from "../../../../test-fixtures/finance";
import { OpenLiaOpenUIProvider } from "../context";
import { openliaLibrary } from "../library";
import { ChartPanelView } from "../charts/ChartPanel";
import { layoutSankey, SankeyDiagramView } from "../charts/SankeyDiagram";
import { FinanceAccountEditor } from "./FinanceAccountEditor";
import { FinanceContext, mappingBalance, mappingLinkState } from "./context";
import {
  FinanceChartView,
  financeSeries,
  financeFlowColors,
} from "./FinanceChart";
import { CHART_COLORS } from "../charts/palette";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
const scope = {
  path: "finance",
  journal: "finance/main.journal",
  from: "2026-10-01",
  to: "2026-11-01",
  accountPrefix: "",
};

it("Finance supplies semantic metadata without changing flow data or debit/credit meaning", () => {
  const nodes = [
    { id: "from:assets:bank", label: "Credit: assets:bank" },
    { id: "to:assets:bank", label: "Debit: assets:bank" },
    { id: "transaction:1", label: "Posting group" },
  ];
  const before = structuredClone(nodes);
  const colored = financeFlowColors(nodes, "finance/main.journal");
  expect(colored[0]?.colorKey).toBe(colored[1]?.colorKey);
  expect(colored[2]?.color).toBe(CHART_COLORS.neutral);
  expect(nodes).toEqual(before);
  const income = financeFlowColors(
    [{ id: "from:income:salary", label: "Salary" }],
    "finance/main.journal",
    [{ name: "income:salary", type: "R", used: true, declared: true }],
  );
  expect(income[0]?.color).toBe(CHART_COLORS.income);
});
async function fixtures() {
  const api = createFinanceMock();
  return {
    api,
    data: await api.loadFinanceContext("finance"),
    report: await api.loadFinanceReport(scope),
  };
}

describe("exact report arithmetic and chart boundaries", () => {
  it("does not lose pennies or large integer precision", () => {
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
    expect(addDecimal("9007199254740993.01", "0.09")).toBe(
      "9007199254740993.1",
    );
    expect(addDecimal("-0.1", "0.1")).toBe("0");
    expect(decimalString(100010n, 2)).toBe("1000.1");
    expect(() => chartNumber("9007199254740993.01")).toThrow("safe chart");
  });
  it("uses native account types and separate commodity amounts for summaries", async () => {
    const { report } = await fixtures();
    expect(financeSeries(report, "USD", "R", "changes", true)).toEqual([
      "1000.25",
    ]);
    expect(financeSeries(report, "USD", "X")).toEqual(["90.1"]);
    expect(financeSeries(report, "EUR", "X")).toEqual(["0"]);
    expect(amountFor({ USD: "1" }, "constructor")).toBe("0");
    expect(
      amountFor(Object.fromEntries([["constructor", "12.5"]]), "constructor"),
    ).toBe("12.5");
  });
});

it("validates Sankey nodes, cycles, negative weights, and empty data without mutating inputs", () => {
  const nodes = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ];
  const links = [{ source: "a", target: "b", value: 10 }];
  const before = structuredClone({ nodes, links });
  expect(layoutSankey(nodes, links)?.nodes).toHaveLength(2);
  expect({ nodes, links }).toEqual(before);
  expect(() =>
    layoutSankey(nodes, [{ source: "unknown", target: "b", value: 1 }]),
  ).toThrow("reference");
  expect(() =>
    layoutSankey(nodes, [...links, { source: "b", target: "a", value: 1 }]),
  ).toThrow("cycles");
  expect(() =>
    layoutSankey(nodes, [{ source: "a", target: "b", value: -1 }]),
  ).toThrow();
  expect(layoutSankey(nodes, [])).toBeNull();
});

it("shows an accessible exact Sankey table and visible invalid-data fallback", () => {
  render(
    <SankeyDiagramView
      nodes={[{ id: "a", label: "Income" }]}
      links={[{ source: "a", target: "missing", value: 10, exact: "10.0001" }]}
      unit="USD"
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("reference");
  fireEvent.click(screen.getByText("Exact data table"));
  expect(screen.getByRole("table")).toHaveTextContent("10.0001");
});

it("rejects negative pie components while retaining their exact table", () => {
  render(
    <ChartPanelView
      kind="pie"
      labels={["Refund"]}
      values={[-10]}
      exactRows={[["Refund", "-10.00"]]}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("cannot be negative");
  fireEvent.click(screen.getByText("Exact data table"));
  expect(screen.getByRole("table")).toHaveTextContent("-10.00");
});

it("distinguishes record link status from balances and independent scopes", async () => {
  const { data, report } = await fixtures();
  const fields = {
    ...data.contract.defaults,
    ledger_account: "assets:bank:B",
    journal_path: "finance/main.journal",
  };
  expect(mappingLinkState(fields, report)).toContain("Linked");
  expect(
    mappingLinkState(
      { ...fields, journal_path: "finance/other.journal" },
      report,
    ),
  ).toBe("Unverified");
  expect(
    mappingLinkState({ ...fields, ledger_account: "assets:new" }, report),
  ).toBe("Not yet present in journal");
  expect(mappingLinkState({ ...fields, journal_path: null }, report)).toBe(
    "No journal configured",
  );
  expect(
    mappingBalance(
      {
        path: "account.md",
        title: "Bank",
        revision: "rev",
        valid: true,
        fields,
      },
      report,
      "USD",
    ),
  ).toBe("1860.4 USD");
  expect(
    mappingBalance(
      {
        path: "account.md",
        title: "Bank",
        revision: "rev",
        valid: true,
        fields: { ...fields, ledger_account: "assets:unused" },
      },
      report,
      "USD",
    ),
  ).toContain("No ledger data");
});

it("exposes account fields and contract before a save; cancellation never calls creation", async () => {
  const { data, report } = await fixtures();
  const save = vi.fn();
  const cancel = vi.fn();
  render(
    <FinanceAccountEditor
      data={data}
      journal="finance/main.journal"
      report={report}
      onSave={save}
      onCancel={cancel}
    />,
  );
  expect(
    screen.getByLabelText("ledger account (schema-required key)"),
  ).toHaveValue("");
  expect(screen.getByLabelText("Ledger scope / main journal")).toHaveValue(
    "finance/main.journal",
  );
  expect(screen.getByText(/Does not create a journal/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("Inspect installed template and schema"));
  expect(
    screen.getByText(/"ledger_account"/, { selector: "pre" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancel).toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it("shows schema validation before posting a mapping and preserves a draft on save conflict", async () => {
  const { data, report } = await fixtures();
  const save = vi.fn().mockRejectedValue(new Error("Contract changed"));
  render(
    <FinanceAccountEditor
      data={data}
      journal=""
      report={report}
      onSave={save}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "Bank B" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save account mapping" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "ledger account are required",
  );
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(
    screen.getByLabelText("ledger account (schema-required key)"),
    { target: { value: "assets:bank:B" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save account mapping" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Contract changed"),
  );
  expect(screen.getByLabelText("Display name")).toHaveValue("Bank B");
});

it("requires an explicit commodity instead of combining currencies", async () => {
  const { data, report } = await fixtures();
  render(
    <FinanceContext.Provider
      value={{
        data,
        report: { ...report, commodities: ["USD", "EUR"] },
        currency: null,
        loading: false,
        newAccount: vi.fn(),
        openFile: undefined,
      }}
    >
      <FinanceChartView report="income-expenses" kind="bar" />
    </FinanceContext.Provider>,
  );
  expect(
    screen.getByText(/Mixed currencies are never summed/),
  ).toBeInTheDocument();
});

it("never treats balances across months as pie slices of a whole", async () => {
  const { data, report } = await fixtures();
  render(
    <FinanceContext.Provider
      value={{
        data,
        report,
        currency: "USD",
        loading: false,
        newAccount: vi.fn(),
        openFile: undefined,
      }}
    >
      <FinanceChartView report="balances" kind="pie" />
    </FinanceContext.Provider>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("not a composition");
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it("renders the actual Finance OpenUI composition and allows a mapping without a journal", async () => {
  const { api } = await fixtures();
  render(
    <OpenLiaOpenUIProvider
      value={{ financeApi: api, domainPath: "finance", onOpenRecord: vi.fn() }}
    >
      <Renderer library={openliaLibrary} response={financeProgram} />
    </OpenLiaOpenUIProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "New account" })).toBeEnabled(),
  );
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Accounts" }), {
    button: 0,
    ctrlKey: false,
  });
  expect(
    screen.getByRole("region", { name: "Finance accounts" }),
  ).toHaveTextContent("No account mappings yet");
  fireEvent.click(screen.getByRole("button", { name: "New account" }));
  const dialog = within(
    screen.getByRole("dialog", { name: "New account mapping" }),
  );
  fireEvent.change(dialog.getByLabelText("Display name"), {
    target: { value: "Cash wallet" },
  });
  fireEvent.change(
    dialog.getByLabelText("ledger account (schema-required key)"),
    { target: { value: "assets:cash" } },
  );
  fireEvent.change(dialog.getByLabelText("Ledger scope / main journal"), {
    target: { value: "" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Save account mapping" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("region", { name: "Finance accounts" }),
  ).toHaveTextContent("Cash wallet");
  expect(
    screen.getByRole("region", { name: "Finance accounts" }),
  ).toHaveTextContent("No journal configured");
});
