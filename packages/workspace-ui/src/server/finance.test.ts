import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  financeAccountTemplate,
  financeAccountSchema,
  financeAccountBody,
  financeAccountDefaults,
  financeJournalFiles,
} from "../../test-fixtures/finance";
import { FinanceService } from "./finance";
import { WorkspaceService, revision } from "./workspace";
import { createWorkspaceHandler } from "./app";
import {
  financeReportSchema,
  type FinanceCreateMapping,
} from "../shared/finance";

let root: string;
let finance: FinanceService;
const binary = process.env.OPENLIA_HLEDGER_BINARY ?? Bun.which("hledger");
const scope = {
  path: "finance",
  journal: "finance/main.journal",
  from: "2026-10-01",
  to: "2026-11-01",
  accountPrefix: "",
};
function installJournals() {
  for (const [path, content] of Object.entries(financeJournalFiles))
    writeFileSync(join(root, "finance", path), content);
}
function create(
  overrides: Partial<FinanceCreateMapping> = {},
): FinanceCreateMapping {
  return {
    path: "finance",
    requestId: crypto.randomUUID(),
    contractRevision: finance.context("finance").contract.revision,
    title: "Bank B",
    fields: {
      ...financeAccountDefaults,
      ledger_account: "assets:bank:B",
      journal_path: "finance/main.journal",
      currencies: ["USD"],
    },
    body: financeAccountBody,
    ...overrides,
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openlia-finance-test-"));
  mkdirSync(join(root, "finance/accounts"), { recursive: true });
  writeFileSync(
    join(root, "finance/accounts/accounts-template.md"),
    financeAccountTemplate,
  );
  writeFileSync(
    join(root, "finance/accounts/accounts-template.schema.json"),
    JSON.stringify(financeAccountSchema),
  );
  finance = new FinanceService(
    new WorkspaceService({ workspaceRoot: root }),
    binary ?? "/missing-hledger",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("exposes hidden contracts before saving and saves only a complete mapping without a journal", () => {
  const context = finance.context("finance");
  expect(context.contract.available).toBe(true);
  expect(context.journals).toEqual([]);
  expect(context.contract.body).toContain("## Reconciliation");
  expect(context.contract.schemaJson.required).toContain("ledger_account");
  const input = create({
    title: "Bank $& 日本語",
    fields: {
      ...financeAccountDefaults,
      ledger_account: "assets:bank:B",
      journal_path: "finance/future.journal",
    },
  });
  const saved = finance.createMapping(input);
  expect(saved.mapping.valid).toBe(true);
  expect(finance.context("finance").mappings).toHaveLength(1);
  expect(existsSync(join(root, "finance/future.journal"))).toBe(false);
  const content = readFileSync(join(root, saved.mapping.path), "utf8");
  expect(content).toContain("# Bank $& 日本語");
  expect(content).toContain("## Mapping");
  expect(content).toContain("## Safety");
  expect(finance.createMapping(input).mapping.path).toBe(saved.mapping.path);
  expect(finance.context("finance").mappings).toHaveLength(1);
  expect(() => finance.createMapping({ ...input, title: "Other" })).toThrow(
    "identifier",
  );
});

test("rejects invalid schemas, stale contracts, path traversal, and field loss without creating shells", () => {
  expect(() => finance.context("../finance")).toThrow();
  expect(() =>
    finance.createMapping(
      create({ fields: { ledger_account: "assets:bank:B" } }),
    ),
  ).toThrow("contract");
  expect(() =>
    finance.createMapping(
      create({
        fields: {
          ...financeAccountDefaults,
          ledger_account: "assets:bank:B",
          journal_path: "finance/../outside.journal",
        },
      }),
    ),
  ).toThrow();
  expect(finance.context("finance").mappings).toEqual([]);
  const stale = create();
  writeFileSync(
    join(root, "finance/accounts/accounts-template.md"),
    `${financeAccountTemplate}\n`,
  );
  expect(() => finance.createMapping(stale)).toThrow("changed");
});

test("read-only draft validation exposes schema errors without saving a mapping or journal", () => {
  const input = create();
  expect(finance.validateMapping(input)).toMatchObject({
    valid: true,
    errors: [],
  });
  expect(finance.context("finance").mappings).toHaveLength(0);
  expect(existsSync(join(root, "finance/main.journal"))).toBe(false);
  expect(
    finance.validateMapping({
      ...input,
      fields: { ledger_account: "assets:bank:B" },
    }).valid,
  ).toBe(false);
  expect(finance.context("finance").mappings).toHaveLength(0);
});

test("preserves custom account fields and sections instead of weakening the local contract", () => {
  const schema = structuredClone(financeAccountSchema) as {
    properties: Record<string, unknown>;
    required: string[];
  };
  schema.properties.review_owner = { type: "string", minLength: 1 };
  schema.required.push("review_owner");
  writeFileSync(
    join(root, "finance/accounts/accounts-template.schema.json"),
    JSON.stringify(schema),
  );
  writeFileSync(
    join(root, "finance/accounts/accounts-template.md"),
    `${financeAccountTemplate.replace("id: null", "review_owner: Me\nid: null")}\n## Local review\nPreserve this section.\n`,
  );
  const contract = finance.context("finance").contract;
  const saved = finance.createMapping(
    create({
      fields: { ...contract.defaults, ledger_account: "assets:new" },
      body: contract.body,
    }),
  );
  expect(saved.mapping.fields.review_owner).toBe("Me");
  expect(readFileSync(join(root, saved.mapping.path), "utf8")).toContain(
    "Preserve this section.",
  );
});

test("a mapping duplicate is warned about, never silently merged", () => {
  const first = finance.createMapping(create());
  const second = finance.createMapping(create());
  expect(first.mapping.path).not.toBe(second.mapping.path);
  expect(second.warnings[0]).toContain("same ledger scope");
});

test("rejects excessive or invalid month ranges", async () => {
  await expect(
    finance.report({ ...scope, from: "2026-10-02" }),
  ).rejects.toThrow("whole calendar months");
  await expect(
    finance.report({ ...scope, to: "2030-01-01" }),
  ).rejects.toThrow();
});

test("mapping writes enforce HTTP origin and never permit journal content in a request", async () => {
  const handler = createWorkspaceHandler({ workspaceRoot: root });
  const response = await handler(
    new Request("http://localhost/api/workspace/finance/accounts", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify(create()),
    }),
  );
  expect(response.status).toBe(403);
  expect(() => finance.createMapping({ ...create(), postings: [] })).toThrow();
  expect(finance.context("finance").mappings).toHaveLength(0);
});

test("contracts cannot expose schema symlinks", () => {
  rmSync(join(root, "finance/accounts/accounts-template.schema.json"));
  symlinkSync(
    join(root, "finance/accounts/accounts-template.md"),
    join(root, "finance/accounts/accounts-template.schema.json"),
  );
  expect(finance.context("finance").contract.available).toBe(false);
});

test("exclusive creation never replaces an existing empty file", () => {
  const path = "finance/accounts/existing.md";
  writeFileSync(join(root, path), "");
  const workspace = new WorkspaceService({ workspaceRoot: root });
  expect(() =>
    workspace.write(path, "New record", revision(new Uint8Array()), true),
  ).toThrow("destination already exists");
  expect(readFileSync(join(root, path), "utf8")).toBe("");
});

describe.skipIf(!binary)("native hledger reports", () => {
  test("supports an empty existing journal without inventing balances", async () => {
    writeFileSync(
      join(root, "finance/main.journal"),
      "; An explicitly empty user journal\n",
    );
    const report = await finance.report(scope);
    expect(report.status).toBe("ok");
    expect(report.commodities).toEqual([]);
    expect(report.balances).toEqual([]);
  });

  test("account prefix filters escape regex metacharacters", async () => {
    writeFileSync(
      join(root, "finance/main.journal"),
      "2026-10-01 Exact\n    assets:bank[1]  12 USD\n    equity:opening\n\n2026-10-02 Other\n    assets:bank1  99 USD\n    equity:opening\n",
    );
    const report = await finance.report({
      ...scope,
      accountPrefix: "assets:bank[1]",
    });
    expect(report.status).toBe("ok");
    expect(report.balances.map((row) => row.account)).toEqual([
      "assets:bank[1]",
    ]);
    expect(report.balances[0]?.amounts[0]?.USD).toBe("12");
  });
  test("reads a main journal with payroll and bank includes without changing any sources", async () => {
    installJournals();
    const before = Object.fromEntries(
      Object.keys(financeJournalFiles).map((path) => [
        path,
        readFileSync(join(root, "finance", path), "utf8"),
      ]),
    );
    expect(finance.context("finance").suggestedJournal).toBe(
      "finance/main.journal",
    );
    const report = await finance.report(scope);
    expect(report.status).toBe("ok");
    expect(report.periods).toEqual(["2026-10"]);
    expect(report.files).toHaveLength(3);
    expect(report.commodities).toContain("USD");
    expect(
      report.accounts.find((account) => account.name === "assets:unused"),
    ).toMatchObject({ declared: true, used: false });
    expect(
      report.changes.find((row) => row.account === "expenses:food")?.amounts[0]
        ?.USD,
    ).toBe("90.1");
    expect(
      report.changes.find((row) => row.account === "income:salary")?.amounts[0]
        ?.USD,
    ).toBe("-1000.25");
    expect(
      report.balances.find((row) => row.account === "assets:bank:B")?.amounts[0]
        ?.USD,
    ).toBe("1860.4");
    expect(
      report.flows.USD?.data?.nodes.some(
        (node) => node.label === "Credit: expenses:food",
      ),
    ).toBe(true);
    finance.createMapping(create());
    for (const [path, content] of Object.entries(before))
      expect(readFileSync(join(root, "finance", path), "utf8")).toBe(content);
    expect(financeReportSchema.safeParse(report).success).toBe(true);
  });

  test("separates independent journals using the same account name", async () => {
    writeFileSync(
      join(root, "finance/one.journal"),
      "2026-10-01 One\n    assets:bank  10 USD\n    equity:opening\n",
    );
    writeFileSync(
      join(root, "finance/two.journal"),
      "2026-10-01 Two\n    assets:bank  20 USD\n    equity:opening\n",
    );
    expect(finance.context("finance").suggestedJournal).toBeNull();
    const one = await finance.report({
      ...scope,
      journal: "finance/one.journal",
    });
    const two = await finance.report({
      ...scope,
      journal: "finance/two.journal",
    });
    expect(
      one.balances.find((row) => row.account === "assets:bank")?.amounts[0]
        ?.USD,
    ).toBe("10");
    expect(
      two.balances.find((row) => row.account === "assets:bank")?.amounts[0]
        ?.USD,
    ).toBe("20");
  });

  test("preserves decimal precision beyond Number safe integers and keeps commodities separate", async () => {
    writeFileSync(
      join(root, "finance/main.journal"),
      "2026-10-01 Exact\n    assets:bank  9007199254740993.01 USD\n    income:salary\n\n2026-10-02 Other currency\n    assets:bank  0.10 EUR\n    income:salary\n\n2026-10-03 More\n    assets:bank  0.20 EUR\n    income:salary\n",
    );
    const report = await finance.report(scope);
    expect(report.status).toBe("ok");
    expect(report.commodities).toEqual(["EUR", "USD"]);
    expect(
      report.balances.find((row) => row.account === "assets:bank")?.amounts[0],
    ).toEqual({ USD: "9007199254740993.01", EUR: "0.3" });
  });

  test("does not fabricate split-transaction pairings or include forecasts", async () => {
    writeFileSync(
      join(root, "finance/main.journal"),
      "2026-10-01 Split\n    expenses:food   10 USD\n    expenses:fees    2 USD\n    assets:bank     -8 USD\n    assets:cash     -4 USD\n\n~ monthly\n    expenses:budget  999 USD\n    assets:cash\n",
    );
    const report = await finance.report(scope);
    expect(report.status).toBe("ok");
    expect(report.flows.USD?.data?.links).toHaveLength(4);
    expect(
      report.flows.USD?.data?.links.every(
        (link) =>
          link.source.startsWith("transaction:") ||
          link.target.startsWith("transaction:"),
      ),
    ).toBe(true);
    expect(
      report.changes.some((row) => row.account === "expenses:budget"),
    ).toBe(false);
  });

  test("aggregates repeated directed posting groups with exact totals, not pairwise allocations", async () => {
    writeFileSync(
      join(root, "finance/main.journal"),
      "2026-10-01 Split\n    expenses:food   10 USD\n    expenses:fees    2 USD\n    assets:bank     -8 USD\n    assets:cash     -4 USD\n\n2026-10-02 Another split\n    expenses:food    5 USD\n    expenses:fees    3 USD\n    assets:bank     -2 USD\n    assets:cash     -6 USD\n",
    );
    const report = await finance.report(scope);
    expect(report.status).toBe("ok");
    const links = report.flows.USD?.data?.links ?? [];
    expect(links).toHaveLength(4);
    expect(
      links
        .filter((link) => link.source.startsWith("transaction:"))
        .map((link) => link.exact)
        .sort(),
    ).toEqual(["15", "5"]);
    expect(
      links
        .filter((link) => link.target.startsWith("transaction:"))
        .map((link) => link.exact),
    ).toEqual(["10", "10"]);
  });

  test("invalid/missing/unavailable journals never produce authoritative totals, but mappings can still save", async () => {
    expect((await finance.report(scope)).status).toBe("missing");
    writeFileSync(
      join(root, "finance/main.journal"),
      "2026-10-01 Invalid\n    assets:bank  10 USD\n    income:salary  -9 USD\n",
    );
    expect((await finance.report(scope)).status).toBe("invalid");
    expect(finance.createMapping(create()).mapping.valid).toBe(true);
    installJournals();
    const unavailable = new FinanceService(
      new WorkspaceService({ workspaceRoot: root }),
      "/missing-hledger",
    );
    expect((await unavailable.report(scope)).status).toBe("unavailable");
  });

  test("rejects include escapes, cycles, repeated files, unsupported readers, and symlinks", async () => {
    for (const directive of [
      "include /etc/passwd",
      "include ../secret.journal",
      "include *.journal",
      "include csv:bank.csv",
      "include main.journal",
    ]) {
      writeFileSync(join(root, "finance/main.journal"), `${directive}\n`);
      expect((await finance.report(scope)).status).toBe("invalid");
    }
    writeFileSync(
      join(root, "finance/main.journal"),
      "include repeated.journal\ninclude repeated.journal\n",
    );
    writeFileSync(join(root, "finance/repeated.journal"), "; Empty\n");
    expect((await finance.report(scope)).status).toBe("invalid");
    rmSync(join(root, "finance/repeated.journal"));
    symlinkSync(
      join(root, "finance/main.journal"),
      join(root, "finance/repeated.journal"),
    );
    await expect(finance.report(scope)).rejects.toThrow();
  });
});
