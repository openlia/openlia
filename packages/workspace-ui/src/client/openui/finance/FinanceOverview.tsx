import { defineComponent } from "@openuidev/react-lang";
import { addDecimal, negateDecimal } from "../../../shared/charts";
import { financeOpenUIProps } from "../../../shared/finance";
import { useFinance } from "./context";
import { financeSeries, hasUnclassifiedAmounts } from "./FinanceChart";

export function FinanceOverviewView({
  title = "Finance overview",
}: {
  title?: string | undefined;
}) {
  const finance = useFinance();
  if (!finance)
    return <p role="alert">FinanceOverview must be inside Finance.</p>;
  if (finance.report?.status !== "ok" || finance.currency === null)
    return (
      <p>
        Choose a validated ledger scope and one currency to see financial
        summaries. Account mappings remain available without reports.
      </p>
    );
  if (hasUnclassifiedAmounts(finance.report, finance.currency))
    return (
      <p role="alert">
        Income and expense summaries are withheld because some accounts lack
        native hledger types. No classification is inferred from mapping labels.
      </p>
    );
  const income = financeSeries(
    finance.report,
    finance.currency,
    "R",
    "changes",
    true,
  ).reduce(addDecimal, "0");
  const spending = financeSeries(finance.report, finance.currency, "X").reduce(
    addDecimal,
    "0",
  );
  const values = [
    { label: "Net income", value: income },
    { label: "Net expenses", value: spending },
    {
      label: "Income less expenses (not cash flow)",
      value: addDecimal(income, negateDecimal(spending)),
    },
  ];
  return (
    <section aria-label="Finance overview" className="space-y-3">
      <h3 className="font-semibold">{title}</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        {values.map((item) => (
          <div
            key={item.label}
            className="border border-base-content/10 rounded-xl p-4"
          >
            <p className="text-xs opacity-70">{item.label}</p>
            <p className="text-xl font-semibold break-all">
              {item.value} {finance.currency || "(unitless)"}
            </p>
          </div>
        ))}
      </div>
      <p className="text-xs opacity-70">
        Actual regular postings only. Transfers and credit-card repayments are
        not additional expenses. Income is the inverse of revenue-account
        postings; refunds reduce expenses. Unknown account types are not
        classified by guesswork.
      </p>
    </section>
  );
}
export const FinanceOverview = defineComponent({
  name: "FinanceOverview",
  description:
    "Exact scoped income/expense summaries from native hledger account types, never mixed currencies",
  props: financeOpenUIProps.FinanceOverview,
  component: ({ props }) => <FinanceOverviewView {...props} />,
});
