import { Renderer } from "@openuidev/react-lang";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { financeProgram } from "../../../test-fixtures/finance";
import { OpenLiaOpenUIProvider } from "../openui/context";
import { openliaLibrary } from "../openui/library";
import { FinanceAccountEditor } from "../openui/finance/FinanceAccountEditor";
import { createStoryApi, action } from "./fixtures";
import type { WorkspaceApi } from "../api";
import type {
  FinanceContextResponse,
  FinanceReport,
} from "../../shared/finance";

const meta = {
  title: "Finance/Dashboard and mappings",
  parameters: {
    componentExports: [
      "openui/finance/Finance.tsx#FinanceView",
      "openui/finance/Finance.tsx#Finance",
      "openui/finance/FinanceOverview.tsx#FinanceOverviewView",
      "openui/finance/FinanceOverview.tsx#FinanceOverview",
      "openui/finance/FinanceChart.tsx#FinanceChartView",
      "openui/finance/FinanceChart.tsx#FinanceChart",
      "openui/finance/FinanceAccounts.tsx#FinanceAccountsView",
      "openui/finance/FinanceAccounts.tsx#FinanceAccounts",
      "openui/finance/FinanceAccountEditor.tsx#FinanceAccountEditor",
    ],
    docs: {
      description: {
        component:
          "The actual Finance OpenUI composition with a fresh synthetic API. Journal reports are read-only; account creation changes mock mappings only.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type State =
  | "ready"
  | "missing"
  | "invalid"
  | "unavailable"
  | "mixed"
  | "contract"
  | "precision"
  | "unclassified"
  | "independent"
  | "refund";
function apiFor(state: State) {
  const api = createStoryApi();
  const context = api.loadFinanceContext.bind(api);
  const report = api.loadFinanceReport.bind(api);
  api.loadFinanceContext = async (path) => {
    const value = await context(path);
    if (state === "missing")
      return {
        ...value,
        journals: [],
        includedJournals: [],
        suggestedJournal: null,
      };
    if (state === "contract")
      return {
        ...value,
        contract: {
          ...value.contract,
          available: false,
          errors: [
            "Installed account contract is invalid; creating a template shell is not a workaround.",
          ],
        },
      };
    if (state === "independent")
      return {
        ...value,
        journals: [`${path}/main.journal`, `${path}/independent.journal`],
        includedJournals: [],
        suggestedJournal: null,
        mappings: ["main", "independent"].map((name) => ({
          path: `${path}/accounts/${name}.md`,
          title: `Bank B / ${name} scope`,
          revision: "fixture",
          valid: true,
          fields: {
            ...value.contract.defaults,
            ledger_account: "assets:bank:B",
            journal_path: `${path}/${name === "main" ? "main" : "independent"}.journal`,
          },
        })),
      };
    return value;
  };
  api.loadFinanceReport = async (scope) => {
    const value = await report(scope);
    if (state === "invalid" || state === "unavailable")
      return {
        ...value,
        status: state,
        message:
          state === "invalid"
            ? "Native hledger validation failed. No financial totals are shown."
            : "hledger is unavailable on the server.",
        changes: [],
        balances: [],
        commodities: [],
      };
    if (state === "mixed")
      return {
        ...value,
        commodities: ["USD", "EUR"],
        changes: value.changes.map((row) => ({
          ...row,
          amounts: row.amounts.map((amount) => ({
            ...amount,
            EUR: row.type === "R" ? "-500" : "20",
          })),
        })),
      };
    if (state === "precision")
      return {
        ...value,
        balances: value.balances.map((row) => ({
          ...row,
          amounts: row.amounts.map(() => ({ USD: "9007199254740993.01" })),
        })),
      };
    if (
      state === "independent" &&
      scope.journal.endsWith("independent.journal")
    )
      return {
        ...value,
        balances: value.balances.map((row) => ({
          ...row,
          amounts: row.amounts.map(() => ({ USD: "420" })),
        })),
      };
    if (state === "unclassified")
      return {
        ...value,
        changes: [
          ...value.changes,
          {
            account: "unclassified",
            type: "",
            amounts: value.periods.map(() => ({ USD: "30" })),
          },
        ],
      };
    if (state === "refund")
      return {
        ...value,
        changes: value.changes.map((row) =>
          row.type === "X"
            ? { ...row, amounts: row.amounts.map(() => ({ USD: "-20" })) }
            : row,
        ),
      };
    return value;
  };
  return api;
}
function Dashboard({ state = "ready" }: { state?: State }) {
  const [api] = useState(() => apiFor(state));
  return (
    <OpenLiaOpenUIProvider
      value={{
        financeApi: api,
        domainPath: "finance",
        onOpenRecord: action("openAccountRecord"),
      }}
    >
      <Renderer library={openliaLibrary} response={financeProgram} />
    </OpenLiaOpenUIProvider>
  );
}
export const DashboardWithFiveViews: Story = { render: () => <Dashboard /> };
export const NoJournal: Story = { render: () => <Dashboard state="missing" /> };
export const InvalidJournal: Story = {
  render: () => <Dashboard state="invalid" />,
};
export const MissingHledger: Story = {
  render: () => <Dashboard state="unavailable" />,
};
export const MixedCurrencies: Story = {
  render: () => <Dashboard state="mixed" />,
};
export const InvalidContract: Story = {
  render: () => <Dashboard state="contract" />,
};
export const ExactValuesBeyondChartRange: Story = {
  render: () => <Dashboard state="precision" />,
};
export const IndependentLedgerScopes: Story = {
  render: () => <Dashboard state="independent" />,
};
export const UnclassifiedAccounts: Story = {
  render: () => <Dashboard state="unclassified" />,
};
export const RefundsRequireBarOrTable: Story = {
  render: () => <Dashboard state="refund" />,
};
const editorLoader = async () => {
  const api = createStoryApi();
  const data = await api.loadFinanceContext("finance");
  const report = await api.loadFinanceReport({
    path: "finance",
    journal: "finance/main.journal",
    from: "2026-10-01",
    to: "2026-11-01",
    accountPrefix: "",
  });
  return { editor: { api, data, report } };
};
export const AccountEditor: Story = {
  loaders: [editorLoader],
  parameters: { docs: { story: { inline: false } } },
  render: function EditorStory(_args, { loaded }) {
    const { api, data, report } = loaded.editor as {
      api: WorkspaceApi;
      data: FinanceContextResponse;
      report: FinanceReport;
    };
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          New account
        </button>
        {open && (
          <FinanceAccountEditor
            data={data}
            report={report}
            journal="finance/main.journal"
            onValidate={(input) => api.validateFinanceMapping(input)}
            onCancel={() => setOpen(false)}
            onSave={async (input) => {
              action("saveMapping")(input);
              await api.createFinanceMapping(input);
              setOpen(false);
            }}
          />
        )}
      </>
    );
  },
};
