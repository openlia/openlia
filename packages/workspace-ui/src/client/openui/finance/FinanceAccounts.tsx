import { defineComponent } from "@openuidev/react-lang";
import { financeOpenUIProps } from "../../../shared/finance";
import { mappingBalance, mappingLinkState, useFinance } from "./context";

export function FinanceAccountsView({
  title = "Account mappings",
}: {
  title?: string | undefined;
}) {
  const finance = useFinance();
  if (!finance)
    return <p role="alert">FinanceAccounts must be inside Finance.</p>;
  return (
    <section aria-label="Finance accounts" className="space-y-3">
      <header className="flex justify-between gap-3">
        <h3 className="font-semibold">{title}</h3>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!finance.data.contract.available}
          onClick={finance.newAccount}
        >
          New account mapping
        </button>
      </header>
      <p className="text-xs opacity-70">
        One account may be used in many included files. A mapping identifies its
        main journal scope, not ownership by a source file. Identical names in
        independent scopes stay separate.
      </p>
      {!finance.data.mappings.length ? (
        <p>No account mappings yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <caption className="sr-only">
              Account mappings, ledger link states, and scoped balances
            </caption>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Ledger account</th>
                <th scope="col">Main journal scope</th>
                <th scope="col">Record status</th>
                <th scope="col">Ledger link</th>
                <th scope="col">End balance (unvalued)</th>
              </tr>
            </thead>
            <tbody>
              {finance.data.mappings.map((mapping) => (
                <tr key={mapping.path}>
                  <td>
                    <button
                      type="button"
                      className="link link-primary text-left"
                      disabled={!finance.openFile}
                      onClick={() => finance.openFile?.(mapping.path)}
                    >
                      {mapping.title}
                    </button>
                    {!mapping.valid && (
                      <span className="badge badge-warning ml-1">
                        Invalid record
                      </span>
                    )}
                  </td>
                  <td>
                    {String(mapping.fields.ledger_account ?? "Not mapped")}
                  </td>
                  <td>{String(mapping.fields.journal_path ?? "None")}</td>
                  <td>{String(mapping.fields.status ?? "Unknown")}</td>
                  <td>{mappingLinkState(mapping.fields, finance.report)}</td>
                  <td>
                    {mappingBalance(mapping, finance.report, finance.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
export const FinanceAccounts = defineComponent({
  name: "FinanceAccounts",
  description:
    "Account mappings with separate record/link states and scope-aware native balances",
  props: financeOpenUIProps.FinanceAccounts,
  component: ({ props }) => <FinanceAccountsView {...props} />,
});
