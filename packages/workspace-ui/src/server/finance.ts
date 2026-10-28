import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { parse as parseLossless } from "lossless-json";
import { z } from "zod";
import YAML from "yaml";
import {
  addDecimal,
  chartNumber,
  decimalString,
  type SankeyData,
} from "../shared/charts";
import { validDate } from "../shared/calendar";
import {
  financeCreateMappingSchema,
  financeReportRequestSchema,
  type FinanceContextResponse,
  type FinanceContract,
  type FinanceMappingValidation,
  type FinanceMappingResult,
  type FinanceReport,
  type FinanceReportRequest,
} from "../shared/finance";
import { parseRecordFrontmatter, validateRecordContent } from "./validator";
import { revision, WorkspaceError, type WorkspaceService } from "./workspace";

const exec = promisify(execFile);
const amountSchema = z.object({
  acommodity: z.string(),
  aquantity: z.object({
    decimalMantissa: z
      .string()
      .regex(/^-?\d+$/)
      .max(220),
    decimalPlaces: z.coerce.number().int().min(0).max(36),
  }),
  acost: z.unknown().optional(),
});
const amountsSchema = z.array(amountSchema);
const accountNameSchema = z.union([
  z.string(),
  z
    .tuple([z.string()])
    .rest(z.unknown())
    .transform((value) => value[0]),
]);
const nativeReportSchema = z.object({
  prDates: z.array(z.unknown()),
  prRows: z.array(
    z.object({
      prrName: accountNameSchema,
      prrAmounts: z.array(amountsSchema),
    }),
  ),
});
const transactionsSchema = z.array(
  z.object({
    tpostings: z.array(
      z.object({
        paccount: z.string(),
        ptype: z.string(),
        pamount: amountsSchema,
      }),
    ),
  }),
);
const nativeJson = (text: string) =>
  parseLossless(text, null, (number) => number);
function fail(
  message: string,
  status = 400,
  code = "invalid_finance_request",
): never {
  throw new WorkspaceError(message, status, code);
}
const journalExtension = /\.(?:journal|hledger)$/i;
const within = (path: string, root: string) => path.startsWith(`${root}/`);
const hasControls = (value: string) =>
  [...value].some(
    (character) =>
      (character.codePointAt(0) ?? 0) < 32 || character.codePointAt(0) === 127,
  );

export function journalIncludes(
  content: string,
  path: string,
  root: string,
): string[] {
  const includes: string[] = [];
  let comment = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*comment\s*$/i.test(line)) {
      comment = true;
      continue;
    }
    if (/^\s*end\s+comment\s*$/i.test(line)) {
      comment = false;
      continue;
    }
    if (comment || /^\s*[;#]/.test(line)) continue;
    const match = /^\s*include\s+(.+)$/i.exec(line);
    if (!match) continue;
    const target = (match[1] ?? "").trim().replace(/^journal:/, "");
    // Never let native hledger open files outside the bounded snapshot or invoke another reader.
    if (
      !target ||
      /[\\*?{}[\]~|:]/.test(target) ||
      hasControls(target) ||
      target.startsWith("/") ||
      !journalExtension.test(target)
    ) {
      fail(
        "UI reports require literal .journal/.hledger includes inside this Finance folder; globs, other readers, and external paths are not supported.",
        422,
        "finance_invalid",
      );
    }
    const resolved = posix.normalize(posix.join(posix.dirname(path), target));
    if (!within(resolved, root))
      fail(
        "Journal include escapes the Finance scope.",
        422,
        "finance_invalid",
      );
    includes.push(resolved);
  }
  return includes;
}

export class FinanceService {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly binary = process.env.OPENLIA_HLEDGER_BINARY || "hledger",
  ) {}

  private root(value: unknown): string {
    if (typeof value !== "string" || !/^[\w-]+(?:\/[\w-]+)*$/.test(value))
      fail("Choose a valid Finance project path.");
    return value;
  }

  private contract(root: string): FinanceContract {
    const empty: FinanceContract = {
      available: false,
      errors: [],
      revision: "",
      templatePath: "",
      schemaPath: "",
      defaults: {},
      body: "",
      schemaJson: {},
    };
    try {
      const contract = this.workspace.collectionContract(`${root}/accounts`);
      const { metadata, body } = parseRecordFrontmatter(contract.template);
      const schemaJson: unknown = JSON.parse(contract.schema);
      if (
        !schemaJson ||
        typeof schemaJson !== "object" ||
        Array.isArray(schemaJson)
      )
        throw new Error("Invalid schema");
      const properties = (schemaJson as Record<string, unknown>).properties;
      if (
        !properties ||
        typeof properties !== "object" ||
        !("ledger_account" in properties)
      )
        throw new Error("The account contract must expose ledger_account.");
      return {
        available: true,
        errors: [],
        revision: contract.revision,
        templatePath: contract.templatePath,
        schemaPath: contract.schemaPath,
        defaults: Object.fromEntries(
          Object.entries(metadata ?? {}).filter(([key]) => key !== "$schema"),
        ),
        body,
        schemaJson: schemaJson as Record<string, unknown>,
      };
    } catch {
      return {
        ...empty,
        errors: [
          "Account creation requires a valid local account template/schema with ledger_account. Install or repair the Personal Finance feature; no shell needs to be saved.",
        ],
      };
    }
  }

  context(path: unknown): FinanceContextResponse {
    const root = this.root(path);
    const tree = this.workspace.tree();
    const entries = tree.entries.filter(
      (entry) => entry.kind === "file" && within(entry.path, root),
    );
    const journals = entries
      .filter((entry) => journalExtension.test(entry.path))
      .map((entry) => entry.path)
      .sort();
    if (journals.length > 64)
      fail("More than 64 journal candidates; narrow the Finance folder.");
    const warnings: string[] = tree.truncated
      ? [
          "Workspace discovery is incomplete. Select the main journal explicitly.",
        ]
      : [];
    const included = new Set<string>();
    let reliable = !tree.truncated;
    for (const path of journals) {
      try {
        for (const include of journalIncludes(
          this.workspace.read(path).content,
          path,
          root,
        ))
          included.add(include);
      } catch {
        reliable = false;
      }
    }
    const roots = journals.filter((path) => !included.has(path));
    if (!reliable)
      warnings.push(
        "Could not reliably identify the include roots. Select a main journal explicitly.",
      );
    const mappingPaths = entries.filter(
      (entry) =>
        entry.path.startsWith(`${root}/accounts/`) &&
        !entry.path.slice(`${root}/accounts/`.length).includes("/") &&
        entry.path.endsWith(".md") &&
        !entry.path.endsWith("-template.md") &&
        !entry.path.endsWith("/README.md"),
    );
    if (mappingPaths.length > 200)
      fail("More than 200 account mappings; narrow the collection.");
    const mappings = mappingPaths.map(({ path }) => {
      const file = this.workspace.read(path);
      const parsed = parseRecordFrontmatter(file.content);
      return {
        path,
        title:
          /^#\s+(.+)$/m.exec(parsed.body)?.[1] ??
          path.split("/").at(-1) ??
          path,
        revision: file.revision,
        fields: Object.fromEntries(
          Object.entries(parsed.metadata ?? {}).filter(
            ([key]) => key !== "$schema",
          ),
        ),
        valid: file.validation?.valid ?? true,
      };
    });
    return {
      schema: 1,
      path: root,
      journals,
      includedJournals: journals.filter((path) => included.has(path)),
      suggestedJournal:
        reliable && roots.length === 1 ? (roots[0] ?? null) : null,
      mappings,
      contract: this.contract(root),
      warnings,
    };
  }

  validateMapping(input: unknown): FinanceMappingValidation {
    try {
      this.createMapping(input, true);
      return { schema: 1, valid: true, errors: [] };
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      return { schema: 1, valid: false, errors: [error.message] };
    }
  }

  createMapping(input: unknown, dryRun = false): FinanceMappingResult {
    const parsed = financeCreateMappingSchema.safeParse(input);
    if (!parsed.success) fail("Invalid account mapping request.");
    const value = parsed.data;
    const root = this.root(value.path);
    const contract = this.contract(root);
    if (!contract.available)
      fail(
        "The local account contract is unavailable.",
        422,
        "contract_unavailable",
      );
    if (value.contractRevision !== contract.revision)
      fail(
        "The account contract changed. Reopen the editor.",
        409,
        "contract_conflict",
      );
    const ledger = value.fields.ledger_account;
    if (
      typeof ledger !== "string" ||
      !ledger.trim() ||
      ledger !== ledger.trim() ||
      hasControls(ledger) ||
      ledger.split(":").some((part) => !part.trim())
    )
      fail(
        "Enter a non-empty ledger account name without empty segments or control characters.",
      );
    const journal = value.fields.journal_path;
    if (
      journal !== null &&
      journal !== undefined &&
      (typeof journal !== "string" ||
        !within(journal, root) ||
        !journalExtension.test(journal) ||
        posix.normalize(journal) !== journal ||
        hasControls(journal) ||
        journal.includes("\\"))
    )
      fail(
        "Main journal must be a workspace-relative journal inside the Finance folder. It does not need to exist.",
      );
    if ("$schema" in value.fields)
      fail("The schema directive is controlled by the local template.");
    const schemaDirective = posix.relative(
      posix.dirname(contract.templatePath),
      contract.schemaPath,
    );
    const body = value.body.replace(/^#\s+.*$/m, () => `# ${value.title}`);
    const content = `---\n${YAML.stringify({ $schema: `./${schemaDirective}`, ...value.fields })}---\n${body.replace(/^\n+/, "")}`;
    const path = `${root}/accounts/${value.requestId}.md`;
    const validation = validateRecordContent(
      this.workspace.workspaceRoot,
      path,
      content,
    );
    if (!validation.valid)
      fail(
        `The mapping does not conform to the installed account contract: ${validation.errors.join("; ")}`,
        422,
        "finance_mapping_invalid",
      );
    const warnings: string[] = [];
    if (
      this.context(root).mappings.some(
        (mapping) =>
          mapping.path !== path &&
          mapping.fields.ledger_account === ledger &&
          (mapping.fields.journal_path ?? null) === (journal ?? null),
      )
    )
      warnings.push(
        "Another mapping has the same ledger scope and account name. No records were merged.",
      );
    if (this.contract(root).revision !== value.contractRevision)
      fail("The account contract changed.", 409, "contract_conflict");
    let existing: ReturnType<WorkspaceService["read"]> | undefined;
    try {
      existing = this.workspace.read(path);
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== "not_found")
        throw error;
    }
    if (existing && existing.content !== content)
      fail(
        "This request identifier already belongs to another record.",
        409,
        "destination_exists",
      );
    if (dryRun)
      return {
        schema: 1,
        mapping: {
          path,
          title: value.title,
          revision: revision(new TextEncoder().encode(content)),
          fields: value.fields,
          valid: true,
        },
        warnings,
      };
    if (!existing)
      this.workspace.write(path, content, revision(new Uint8Array()), true);
    const saved = this.workspace.read(path);
    return {
      schema: 1,
      mapping: {
        path,
        title: value.title,
        revision: saved.revision,
        fields: value.fields,
        valid: saved.validation?.valid ?? true,
      },
      warnings,
    };
  }

  private snapshot(scope: FinanceReportRequest) {
    if (
      !within(scope.journal, scope.path) ||
      !journalExtension.test(scope.journal) ||
      posix.normalize(scope.journal) !== scope.journal
    )
      fail("Choose a main journal inside this Finance folder.");
    const files = new Map<string, string>();
    let bytes = 0;
    const visit = (path: string) => {
      if (files.has(path))
        fail(
          "An included file is repeated or cyclic. Refusing potentially duplicated financial reports.",
          422,
          "finance_invalid",
        );
      if (files.size >= 32)
        fail("Journal include tree exceeds 32 files.", 422, "finance_invalid");
      const file = this.workspace.read(path);
      bytes += Buffer.byteLength(file.content);
      if (bytes > 4 * 1024 * 1024)
        fail("Journal snapshot exceeds 4 MiB.", 422, "finance_invalid");
      files.set(path, file.content);
      for (const include of journalIncludes(file.content, path, scope.path))
        visit(include);
    };
    visit(scope.journal);
    const hash = createHash("sha256");
    for (const [path, content] of [...files].sort(([a], [b]) =>
      a.localeCompare(b),
    ))
      hash.update(path).update("\0").update(content).update("\0");
    return { files, revision: `sha256:${hash.digest("hex")}` };
  }

  async report(input: unknown): Promise<FinanceReport> {
    const parsed = financeReportRequestSchema.safeParse(input);
    if (!parsed.success) fail("Invalid Finance report scope.");
    const scope = parsed.data;
    this.root(scope.path);
    if (
      !validDate(scope.from) ||
      !validDate(scope.to) ||
      !scope.from.endsWith("-01") ||
      !scope.to.endsWith("-01") ||
      scope.from >= scope.to ||
      Date.parse(scope.to) - Date.parse(scope.from) > 732 * 86400000 ||
      hasControls(scope.accountPrefix)
    )
      fail(
        "Reports require whole calendar months, an exclusive end, and at most 24 months.",
      );
    const periods: string[] = [];
    const date = new Date(`${scope.from}T12:00:00Z`);
    while (date.toISOString().slice(0, 10) < scope.to) {
      periods.push(date.toISOString().slice(0, 7));
      date.setUTCMonth(date.getUTCMonth() + 1);
    }
    const empty: FinanceReport = {
      schema: 1,
      status: "invalid",
      message: "",
      scope,
      revision: "",
      files: [],
      periods,
      commodities: [],
      accounts: [],
      changes: [],
      balances: [],
      flows: {},
      warnings: [],
      commands: [],
    };
    let temporary = "";
    try {
      const snapshot = this.snapshot(scope);
      temporary = mkdtempSync(join(tmpdir(), "openlia-finance-"));
      for (const [path, content] of snapshot.files) {
        const destination = join(temporary, posix.relative(scope.path, path));
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, content, { mode: 0o600 });
      }
      const root = posix.relative(scope.path, scope.journal);
      const commands: string[] = [];
      const run = async (args: string[]) => {
        commands.push(
          ["hledger", "-f", `journal:${scope.journal}`, ...args]
            .map((argument) => JSON.stringify(argument))
            .join(" "),
        );
        try {
          const result = await exec(
            this.binary,
            ["-f", `journal:${root}`, ...args],
            {
              cwd: temporary,
              timeout: 8000,
              maxBuffer: 8 * 1024 * 1024,
              env: {
                PATH: process.env.PATH,
                HOME: temporary,
                LANG: "C.UTF-8",
                TZ: "UTC",
              },
            },
          );
          if (result.stderr.trim()) throw new Error("Native diagnostics");
          return result.stdout;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            fail(
              "Native hledger is unavailable on the workspace-ui server.",
              503,
              "finance_unavailable",
            );
          fail(
            "Native hledger reported an invalid journal, unsupported report format, or execution/output limit. No ledger was modified.",
            422,
            "finance_invalid",
          );
        }
      };
      await run(["check"]);
      const [plain, all, declared, used] = await Promise.all([
        run(["accounts"]),
        run(["accounts", "--types"]),
        run(["accounts", "--declared"]),
        run(["accounts", "--used"]),
      ]);
      const declaredSet = new Set(declared.split(/\r?\n/));
      const usedSet = new Set(used.split(/\r?\n/));
      const names = plain.split(/\r?\n/).filter(Boolean);
      const typed = all.split(/\r?\n/).filter(Boolean);
      if (names.length > 2000 || names.length !== typed.length)
        throw new Error("Unsupported native account listing");
      const consumed = new Set<number>();
      const accounts = names.map((name) => {
        // Match plain native names first; text in an account name is never a type declaration.
        const exact = typed.findIndex(
          (line, index) => !consumed.has(index) && line === name,
        );
        const matches =
          exact >= 0
            ? [exact]
            : typed.flatMap((line, index) =>
                !consumed.has(index) &&
                line.startsWith(name) &&
                /^[ \t]+; type: [A-Z]\s*$/.test(line.slice(name.length))
                  ? [index]
                  : [],
              );
        if (matches.length !== 1)
          throw new Error("Ambiguous native account type listing");
        const index = matches[0] as number;
        consumed.add(index);
        const suffix = typed[index]?.slice(name.length) ?? "";
        return {
          name,
          type: /; type: ([A-Z])/.exec(suffix)?.[1] ?? "",
          declared: declaredSet.has(name),
          used: usedSet.has(name),
        };
      });
      const typeMap = new Map(
        accounts.map((account) => [account.name, account.type]),
      );
      const filter = scope.accountPrefix
        ? [
            `acct:^${scope.accountPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(:|$)`,
          ]
        : [];
      const flags = [
        "--flat",
        "--real",
        "--monthly",
        "--empty",
        "--output-format=json",
        `--begin=${scope.from}`,
        `--end=${scope.to}`,
        ...filter,
      ];
      const readRows = (text: string) => {
        const report = nativeReportSchema.parse(nativeJson(text));
        if (
          report.prDates.length !== periods.length ||
          report.prRows.length > 1000
        )
          throw new Error("Unexpected or excessive native report scope");
        return report.prRows.map((row) => {
          if (row.prrAmounts.length !== periods.length)
            throw new Error("Unexpected native period count");
          return {
            account: row.prrName,
            type: typeMap.get(row.prrName) ?? "",
            amounts: row.prrAmounts.map((amounts) => {
              const values = new Map<string, string>();
              for (const amount of amounts) {
                const quantity = decimalString(
                  BigInt(amount.aquantity.decimalMantissa),
                  amount.aquantity.decimalPlaces,
                );
                values.set(
                  amount.acommodity,
                  addDecimal(values.get(amount.acommodity) ?? "0", quantity),
                );
              }
              return Object.fromEntries(values);
            }),
          };
        });
      };
      const [changeText, balanceText] = await Promise.all([
        run(["balance", ...flags]),
        run(["balance", "--historical", ...flags]),
      ]);
      const changes = readRows(changeText);
      const balances = readRows(balanceText);
      const commodities = [
        ...new Set(
          [...changes, ...balances].flatMap((row) =>
            row.amounts.flatMap(Object.keys),
          ),
        ),
      ].sort();
      const flows: FinanceReport["flows"] = Object.create(null);
      try {
        const transactions = transactionsSchema.parse(
          nativeJson(
            await run([
              "print",
              "--real",
              "--output-format=json",
              `--begin=${scope.from}`,
              `--end=${scope.to}`,
              ...filter,
            ]),
          ),
        );
        for (const commodity of commodities)
          flows[commodity] = this.flows(transactions, commodity);
      } catch {
        for (const commodity of commodities)
          flows[commodity] = {
            data: null,
            reason:
              "Posting-flow report is unavailable or exceeds its limits; balance reports above remain complete.",
          };
      }
      return {
        ...empty,
        status: "ok",
        message:
          "Validated native hledger reports. Quantities are unvalued; currencies/commodities are never combined.",
        revision: snapshot.revision,
        files: [...snapshot.files.keys()],
        accounts,
        commodities,
        changes,
        balances,
        flows,
        commands,
        warnings: [
          "Account balances include prior history. Income/expenses use only the selected months. Transfers are not income or spending. Reports do not detect duplicate real-world events across statements and payslips.",
        ],
      };
    } catch (error) {
      if (
        error instanceof WorkspaceError &&
        !["finance_invalid", "finance_unavailable", "not_found"].includes(
          error.code,
        )
      )
        throw error;
      return {
        ...empty,
        status:
          error instanceof WorkspaceError &&
          error.code === "finance_unavailable"
            ? "unavailable"
            : error instanceof WorkspaceError && error.code === "not_found"
              ? "missing"
              : "invalid",
        message:
          error instanceof WorkspaceError
            ? error.message
            : "Unsupported native hledger JSON/precision. No authoritative report is shown and no ledger was modified.",
      };
    } finally {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    }
  }

  private flows(
    transactions: z.infer<typeof transactionsSchema>,
    commodity: string,
  ): FinanceReport["flows"][string] {
    const nodes = new Map<string, { id: string; label: string }>();
    const groups = new Map<string, string>();
    const edges = new Map<
      string,
      { source: string; target: string; exact: string }
    >();
    const unavailable = (reason: string) => ({ data: null, reason });
    if (
      transactions.some((transaction) =>
        transaction.tpostings.some(
          (posting) =>
            ![
              "RegularPosting",
              "VirtualPosting",
              "BalancedVirtualPosting",
            ].includes(posting.ptype),
        ),
      )
    )
      return unavailable(
        "Unsupported native posting type; no partial or guessed flow graph is shown.",
      );
    if (transactions.length > 300)
      return unavailable(
        "More than 300 transactions. Narrow the range; no partial flow graph is shown.",
      );
    for (const transaction of transactions) {
      const postings = transaction.tpostings
        .filter((posting) => posting.ptype === "RegularPosting")
        .flatMap((posting) =>
          posting.pamount
            .filter((amount) => amount.acommodity === commodity)
            .map((amount) => ({ account: posting.paccount, amount })),
        );
      if (postings.some((posting) => posting.amount.acost))
        return unavailable(
          "Costed/exchange transactions need an explicit valuation policy. No ambiguous commodity flow is drawn.",
        );
      const entries = postings.map((posting) => ({
        account: posting.account,
        exact: decimalString(
          BigInt(posting.amount.aquantity.decimalMantissa),
          posting.amount.aquantity.decimalPlaces,
        ),
      }));
      const total = entries.reduce(
        (sum, posting) => addDecimal(sum, posting.exact),
        "0",
      );
      if (total !== "0")
        return unavailable(
          "Postings do not balance within this commodity. Exchanges or virtual postings require a different flow model; none is invented.",
        );
      const signature = [
        ...new Set(
          entries
            .filter((posting) => posting.exact !== "0")
            .map(
              (posting) =>
                `${posting.exact.startsWith("-") ? "from" : "to"}:${posting.account}`,
            ),
        ),
      ]
        .sort()
        .join("\0");
      if (!signature) continue;
      let hub = groups.get(signature);
      if (!hub) {
        hub = `transaction:${groups.size + 1}`;
        groups.set(signature, hub);
        nodes.set(hub, { id: hub, label: `Posting group ${groups.size}` });
      }
      for (const posting of entries) {
        const exact = posting.exact;
        if (exact === "0") continue;
        const credit = exact.startsWith("-");
        const account = `${credit ? "from" : "to"}:${posting.account}`;
        nodes.set(account, {
          id: account,
          label: `${credit ? "Credit" : "Debit"}: ${posting.account}`,
        });
        const source = credit ? account : hub;
        const target = credit ? hub : account;
        const key = `${source}\0${target}`;
        edges.set(key, {
          source,
          target,
          exact: addDecimal(
            edges.get(key)?.exact ?? "0",
            exact.replace(/^-/, ""),
          ),
        });
      }
    }
    if (nodes.size > 200 || edges.size > 400)
      return unavailable(
        "Flow graph exceeds 200 nodes / 400 links. Narrow the report range.",
      );
    const links: SankeyData["links"] = [...edges.values()].map((edge) => ({
      ...edge,
      value: chartNumber(edge.exact),
    }));
    return {
      data: { nodes: [...nodes.values()], links },
      reason:
        "Accounting posting flow: credits → transaction groups → debits. Transactions sharing the same directed account set are aggregated; no cash-spending or payer-to-payee allocation is inferred. Counterpart accounts are included for matching transactions.",
    };
  }
}
