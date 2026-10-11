export interface JournalPosting {
  account: string;
  amount: number;
  currency: string;
  hasAmount: boolean;
  rawText?: string | undefined;
}

export interface JournalTransaction {
  id: string;
  date: string;
  status?: string | undefined;
  description: string;
  postings: JournalPosting[];
  lineNumber: number;
}

export type RootAccountType =
  | "income"
  | "expenses"
  | "assets"
  | "liabilities"
  | "equity"
  | "other";

export interface AccountBalance {
  currency: string;
  inflow: number;
  outflow: number;
  net: number;
  count: number;
}

export interface AccountSummary {
  name: string;
  rootType: RootAccountType;
  balances: Map<string, AccountBalance>;
}

export interface SankeyNode {
  id: string;
  name: string;
  column: 0 | 1 | 2; // 0 = Inflow (Income), 1 = Pool/Assets, 2 = Outflow (Expenses)
  value: number;
  currency: string;
  type: "income" | "asset" | "expense" | "pool" | "savings";
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
  currency: string;
}

export interface TopCategory {
  name: string;
  amount: number;
  percentage: number;
  currency: string;
}

export interface JournalHighlightsData {
  totalIncome: number;
  totalExpenses: number;
  netSavings: number;
  savingsRate: number;
  transactionCount: number;
  startDate: string | null;
  endDate: string | null;
  currency: string;
  topExpenseCategories: TopCategory[];
}

export interface ParsedJournal {
  transactions: JournalTransaction[];
  accounts: Map<string, AccountSummary>;
  highlightsByCurrency: Map<string, JournalHighlightsData>;
  highlights: JournalHighlightsData;
  sankeyByCurrency: Map<string, { nodes: SankeyNode[]; links: SankeyLink[] }>;
  sankeyNodes: SankeyNode[];
  sankeyLinks: SankeyLink[];
  currencies: string[];
}

export function classifyAccount(accountName: string): RootAccountType {
  const lower = accountName.toLowerCase().trim();
  if (lower.startsWith("income") || lower.startsWith("revenues"))
    return "income";
  if (lower.startsWith("expenses") || lower.startsWith("expense"))
    return "expenses";
  if (lower.startsWith("assets") || lower.startsWith("asset")) return "assets";
  if (lower.startsWith("liabilities") || lower.startsWith("liability"))
    return "liabilities";
  if (lower.startsWith("equity")) return "equity";
  return "other";
}

// Parses amount strings like "20618182 VND", "-22909091 VND", "$50.00", "-$50.00", "1,500.00 USD"
export function parseAmountAndCurrency(
  raw: string,
  defaultCurrency = "VND",
): { amount: number; currency: string } {
  let cleaned = raw.trim();
  let negative = false;

  if (cleaned.startsWith("-")) {
    negative = true;
    cleaned = cleaned.slice(1).trim();
  }

  // Symbol currency prefix like $ or € or £
  let currency = defaultCurrency;
  if (cleaned.startsWith("$")) {
    currency = "USD";
    cleaned = cleaned.slice(1).trim();
  } else if (cleaned.startsWith("€")) {
    currency = "EUR";
    cleaned = cleaned.slice(1).trim();
  } else if (cleaned.startsWith("£")) {
    currency = "GBP";
    cleaned = cleaned.slice(1).trim();
  } else if (cleaned.startsWith("¥")) {
    currency = "JPY";
    cleaned = cleaned.slice(1).trim();
  }

  // Check currency suffix or prefix word
  const matchTrailing = cleaned.match(
    /^([+-]?[\d,]+(?:\.\d+)?)\s*([A-Za-z₫$€£]+)?$/,
  );
  const matchLeading = cleaned.match(
    /^([A-Za-z₫$€£]+)\s*([+-]?[\d,]+(?:\.\d+)?)$/,
  );

  let numStr = "";
  if (matchTrailing) {
    numStr = matchTrailing[1] ?? "";
    if (matchTrailing[2]) currency = matchTrailing[2];
  } else if (matchLeading) {
    if (matchLeading[1]) currency = matchLeading[1];
    numStr = matchLeading[2] ?? "";
  } else {
    // Fallback: extract numbers
    const numMatch = cleaned.match(/[+-]?[\d,]+(?:\.\d+)?/);
    if (numMatch) {
      numStr = numMatch[0];
      const remaining = cleaned.replace(numStr, "").trim();
      if (remaining) currency = remaining;
    }
  }

  // Remove commas used as thousands separators
  const normalizedNum = numStr.replace(/,/g, "");
  let parsedVal = parseFloat(normalizedNum);
  if (Number.isNaN(parsedVal)) {
    parsedVal = 0;
  }
  if (negative) {
    parsedVal = -Math.abs(parsedVal);
  }

  return { amount: parsedVal, currency: currency.trim() || defaultCurrency };
}

export function parseHledgerJournal(content: string): ParsedJournal {
  const lines = content.split(/\r?\n/);
  const transactions: JournalTransaction[] = [];
  const currencyCounts = new Map<string, number>();

  let currentTx: JournalTransaction | null = null;
  let txIndex = 0;

  // Header regex: YYYY[-/.]MM[-/.]DD [*|!]? [Description]
  const dateHeaderRegex = /^(\d{4}[-/.]\d{2}[-/.]\d{2})\s*(?:([*!])\s*)?(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) {
      // Empty or full comment line
      continue;
    }

    // Check if line is indented (posting)
    const isIndented = /^\s{2,}|\t/.test(rawLine);

    if (isIndented && currentTx) {
      // It's a posting line
      // Strip comments: ";" or "#"
      const commentIndex = trimmed.search(/[;#]/);
      const postingText =
        commentIndex >= 0 ? trimmed.slice(0, commentIndex).trim() : trimmed;

      if (!postingText) continue;

      // Extract account and amount
      // Account names can contain spaces in some ledgers, but usually separated from amount by 2+ spaces or tab
      const parts = postingText.split(/\s{2,}|\t+/);
      const accountName = parts[0]?.trim() ?? "";

      let parsedAmount = 0;
      let parsedCurrency = "";
      let hasAmount = false;

      if (parts.length > 1 && parts[1]?.trim()) {
        const amountPart = parts.slice(1).join(" ").trim();
        const res = parseAmountAndCurrency(amountPart);
        parsedAmount = res.amount;
        parsedCurrency = res.currency;
        hasAmount = true;
      }

      currentTx.postings.push({
        account: accountName,
        amount: parsedAmount,
        currency: parsedCurrency,
        hasAmount,
        rawText: postingText,
      });
    } else {
      // Check if header line
      const headerMatch = trimmed.match(dateHeaderRegex);
      if (headerMatch) {
        if (currentTx) {
          finalizeTransaction(currentTx);
          transactions.push(currentTx);
        }

        const date = headerMatch[1]?.replace(/[/.]/g, "-") ?? "";
        const status = headerMatch[2];
        let description = headerMatch[3]?.trim() ?? "";
        // Remove trailing comment
        const commentIdx = description.search(/[;#]/);
        if (commentIdx >= 0) {
          description = description.slice(0, commentIdx).trim();
        }

        txIndex++;
        currentTx = {
          id: `tx-${txIndex}-${date}`,
          date,
          status,
          description: description || "Untitled transaction",
          postings: [],
          lineNumber: i + 1,
        };
      }
    }
  }

  if (currentTx) {
    finalizeTransaction(currentTx);
    transactions.push(currentTx);
  }

  // Count currencies after balancing so inferred postings are included.
  for (const tx of transactions) {
    for (const post of tx.postings) {
      if (post.hasAmount && post.currency) {
        currencyCounts.set(
          post.currency,
          (currencyCounts.get(post.currency) ?? 0) + 1,
        );
      }
    }
  }

  const currencies = Array.from(currencyCounts.keys());
  const primaryCurrency = currencies[0] ?? "VND";

  // Calculate account summaries without combining different commodities.
  const accounts = new Map<string, AccountSummary>();
  const currencyTotals = new Map<
    string,
    { totalIncome: number; totalExpenses: number; transactionIds: Set<string> }
  >();

  for (const tx of transactions) {
    for (const post of tx.postings) {
      if (!post.hasAmount || !post.currency) continue;

      let totals = currencyTotals.get(post.currency);
      if (!totals) {
        totals = {
          totalIncome: 0,
          totalExpenses: 0,
          transactionIds: new Set<string>(),
        };
        currencyTotals.set(post.currency, totals);
      }
      totals.transactionIds.add(tx.id);

      const type = classifyAccount(post.account);
      let acc = accounts.get(post.account);
      if (!acc) {
        acc = {
          name: post.account,
          rootType: type,
          balances: new Map<string, AccountBalance>(),
        };
        accounts.set(post.account, acc);
      }

      let balance = acc.balances.get(post.currency);
      if (!balance) {
        balance = {
          currency: post.currency,
          inflow: 0,
          outflow: 0,
          net: 0,
          count: 0,
        };
        acc.balances.set(post.currency, balance);
      }
      balance.count += 1;
      balance.net += post.amount;

      if (type === "income") {
        // In hledger, income balances are negative (-). Outflow from income account into asset
        const positiveVal = Math.abs(post.amount);
        balance.inflow += positiveVal;
        totals.totalIncome += positiveVal;
      } else if (type === "expenses") {
        // Expenses are positive (+)
        const positiveVal = Math.max(0, post.amount);
        balance.outflow += positiveVal;
        totals.totalExpenses += positiveVal;
      } else if (post.amount > 0) {
        balance.inflow += post.amount;
      } else {
        balance.outflow += Math.abs(post.amount);
      }
    }
  }

  const highlightsByCurrency = new Map<string, JournalHighlightsData>();
  const sankeyByCurrency = new Map<
    string,
    { nodes: SankeyNode[]; links: SankeyLink[] }
  >();

  for (const currency of currencies) {
    const totals = currencyTotals.get(currency) ?? {
      totalIncome: 0,
      totalExpenses: 0,
      transactionIds: new Set<string>(),
    };
    const currencyDates = transactions
      .filter((tx) => totals.transactionIds.has(tx.id))
      .map((tx) => tx.date)
      .sort();
    const startDate = currencyDates[0] ?? null;
    const endDate = currencyDates[currencyDates.length - 1] ?? null;

    const expenseCategories: { name: string; amount: number }[] = [];
    for (const [name, acc] of accounts.entries()) {
      const balance = acc.balances.get(currency);
      if (acc.rootType === "expenses" && balance && balance.outflow > 0) {
        expenseCategories.push({ name, amount: balance.outflow });
      }
    }
    expenseCategories.sort((a, b) => b.amount - a.amount);

    const topExpenseCategories: TopCategory[] = expenseCategories
      .slice(0, 5)
      .map((cat) => ({
        name: cat.name,
        amount: cat.amount,
        percentage:
          totals.totalExpenses > 0
            ? (cat.amount / totals.totalExpenses) * 100
            : 0,
        currency,
      }));

    const netSavings = totals.totalIncome - totals.totalExpenses;
    const savingsRate =
      totals.totalIncome > 0
        ? Math.max(0, (netSavings / totals.totalIncome) * 100)
        : 0;

    highlightsByCurrency.set(currency, {
      totalIncome: totals.totalIncome,
      totalExpenses: totals.totalExpenses,
      netSavings,
      savingsRate,
      transactionCount: totals.transactionIds.size,
      startDate,
      endDate,
      currency,
      topExpenseCategories,
    });

    sankeyByCurrency.set(
      currency,
      buildSankeyData(
        accounts,
        totals.totalIncome,
        totals.totalExpenses,
        netSavings,
        currency,
      ),
    );
  }

  const highlights =
    highlightsByCurrency.get(primaryCurrency) ??
    createEmptyHighlights(primaryCurrency);
  const primarySankey = sankeyByCurrency.get(primaryCurrency) ?? {
    nodes: [],
    links: [],
  };

  return {
    transactions,
    accounts,
    highlightsByCurrency,
    highlights,
    sankeyByCurrency,
    sankeyNodes: primarySankey.nodes,
    sankeyLinks: primarySankey.links,
    currencies,
  };
}

function finalizeTransaction(tx: JournalTransaction): void {
  // Infer one omitted posting only when its commodity is unambiguous. Explicit
  // zero amounts must not be mistaken for omitted balancing postings.
  const missingPostings = tx.postings.filter((p) => !p.hasAmount);
  const knownCurrencies = Array.from(
    new Set(
      tx.postings
        .filter((p) => p.hasAmount && p.currency)
        .map((p) => p.currency),
    ),
  );
  const missingPosting =
    missingPostings.length === 1 ? missingPostings[0] : null;
  if (missingPosting && knownCurrencies.length === 1) {
    const currency = knownCurrencies[0] ?? "";
    const sum = tx.postings
      .filter((p) => p.hasAmount && p.currency === currency)
      .reduce((total, p) => total + p.amount, 0);
    missingPosting.amount = -sum;
    missingPosting.currency = currency;
    missingPosting.hasAmount = true;
  }
}

function createEmptyHighlights(currency: string): JournalHighlightsData {
  return {
    totalIncome: 0,
    totalExpenses: 0,
    netSavings: 0,
    savingsRate: 0,
    transactionCount: 0,
    startDate: null,
    endDate: null,
    currency,
    topExpenseCategories: [],
  };
}

// Builds the 3-column Sankey flow:
// Column 0: Inflow / Income Sources
// Column 1: Central Account / Liquidity Pool
// Column 2: Outflow / Expenses & Net Retained
function buildSankeyData(
  accounts: Map<string, AccountSummary>,
  totalIncome: number,
  totalExpenses: number,
  netSavings: number,
  currency: string,
): { nodes: SankeyNode[]; links: SankeyLink[] } {
  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];

  const poolId = "pool:liquidity";
  const poolNode: SankeyNode = {
    id: poolId,
    name: "Account Pool / Assets",
    column: 1,
    value: Math.max(totalIncome, totalExpenses),
    currency,
    type: "pool",
  };
  nodes.push(poolNode);

  // Inflow (Column 0)
  const incomeAccounts = Array.from(accounts.values())
    .map((account) => ({ account, balance: account.balances.get(currency) }))
    .filter(
      (entry): entry is { account: AccountSummary; balance: AccountBalance } =>
        entry.account.rootType === "income" &&
        !!entry.balance &&
        entry.balance.inflow > 0,
    )
    .sort((a, b) => b.balance.inflow - a.balance.inflow);

  if (incomeAccounts.length > 0) {
    for (const { account: acc, balance } of incomeAccounts) {
      const nodeId = `node:${acc.name}`;
      // Display friendly shortened name, e.g. income:salary:payslip -> salary:payslip
      const displayName = acc.name.replace(/^income:/i, "");
      nodes.push({
        id: nodeId,
        name: displayName,
        column: 0,
        value: balance.inflow,
        currency,
        type: "income",
      });

      links.push({
        source: nodeId,
        target: poolId,
        value: balance.inflow,
        currency,
      });
    }
  } else if (totalExpenses > 0) {
    // If no income accounts defined, add "Available Funds / Opening Balance"
    const openingId = "node:opening_balance";
    nodes.push({
      id: openingId,
      name: "Available Funds / Prior Assets",
      column: 0,
      value: totalExpenses,
      currency,
      type: "asset",
    });
    links.push({
      source: openingId,
      target: poolId,
      value: totalExpenses,
      currency,
    });
  }

  // Outflow (Column 2)
  const expenseAccounts = Array.from(accounts.values())
    .map((account) => ({ account, balance: account.balances.get(currency) }))
    .filter(
      (entry): entry is { account: AccountSummary; balance: AccountBalance } =>
        entry.account.rootType === "expenses" &&
        !!entry.balance &&
        entry.balance.outflow > 0,
    )
    .sort((a, b) => b.balance.outflow - a.balance.outflow);

  // Group smaller expenses if there are more than 7 to avoid clutter
  const maxExpenses = 6;
  const majorExpenses = expenseAccounts.slice(0, maxExpenses);
  const otherExpenses = expenseAccounts.slice(maxExpenses);

  for (const expenseAccount of majorExpenses) {
    const { account: acc, balance } = expenseAccount;
    const nodeId = `node:${acc.name}`;
    const displayName = acc.name.replace(/^expenses:/i, "");
    nodes.push({
      id: nodeId,
      name: displayName,
      column: 2,
      value: balance.outflow,
      currency,
      type: "expense",
    });

    links.push({
      source: poolId,
      target: nodeId,
      value: balance.outflow,
      currency,
    });
  }

  if (otherExpenses.length > 0) {
    const otherTotal = otherExpenses.reduce(
      (sum, e) => sum + e.balance.outflow,
      0,
    );
    const otherId = "node:expenses:other";
    nodes.push({
      id: otherId,
      name: "Other Expenses",
      column: 2,
      value: otherTotal,
      currency,
      type: "expense",
    });

    links.push({
      source: poolId,
      target: otherId,
      value: otherTotal,
      currency,
    });
  }

  // If there is net savings / retained surplus, add "Net Retained / Savings"
  if (netSavings > 0) {
    const savingsId = "node:retained_savings";
    nodes.push({
      id: savingsId,
      name: "Net Retained / Savings",
      column: 2,
      value: netSavings,
      currency,
      type: "savings",
    });

    links.push({
      source: poolId,
      target: savingsId,
      value: netSavings,
      currency,
    });
  }

  return { nodes, links };
}

export function formatCurrency(amount: number, currency = "VND"): string {
  const rounded = Math.round(amount * 100) / 100;
  if (currency === "VND") {
    // Format large VND amounts nicely (e.g., 20.62M VND or formatted number)
    if (Math.abs(rounded) >= 1_000_000) {
      const millions = rounded / 1_000_000;
      return `${millions.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}M ₫`;
    }
    return `${rounded.toLocaleString()} ₫`;
  }
  if (currency === "USD") {
    return `$${rounded.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${rounded.toLocaleString()} ${currency}`;
}

export interface TransactionSummary {
  type: "income" | "expense" | "transfer";
  totalIncome: number;
  totalExpenses: number;
  netImpact: number;
  primaryCurrency: string;
}

export function classifyTransaction(
  tx: JournalTransaction,
): TransactionSummary {
  let totalIncome = 0;
  let totalExpenses = 0;
  const currencyCounts = new Map<string, number>();

  for (const post of tx.postings) {
    if (post.hasAmount && post.currency) {
      currencyCounts.set(
        post.currency,
        (currencyCounts.get(post.currency) ?? 0) + 1,
      );
      const accType = classifyAccount(post.account);
      if (accType === "income") {
        totalIncome += Math.abs(post.amount);
      } else if (accType === "expenses") {
        totalExpenses += Math.max(0, post.amount);
      }
    }
  }

  let primaryCurrency = "VND";
  let maxCount = -1;
  for (const [cur, count] of currencyCounts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      primaryCurrency = cur;
    }
  }

  let type: "income" | "expense" | "transfer" = "transfer";
  if (totalIncome > 0 && totalExpenses === 0) {
    type = "income";
  } else if (totalExpenses > 0 && totalIncome === 0) {
    type = "expense";
  } else if (totalIncome > 0 && totalExpenses > 0) {
    type = totalIncome >= totalExpenses ? "income" : "expense";
  } else {
    type = "transfer";
  }

  let netImpact = 0;
  if (type === "income") {
    netImpact = totalIncome - totalExpenses;
  } else if (type === "expense") {
    netImpact = -(totalExpenses - totalIncome);
  } else {
    const positivePost = tx.postings.find((p) => p.amount > 0 && p.hasAmount);
    netImpact = positivePost ? positivePost.amount : 0;
  }

  return {
    type,
    totalIncome,
    totalExpenses,
    netImpact,
    primaryCurrency,
  };
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface MonthTransactionGroup {
  monthKey: string; // "YYYY-MM"
  label: string; // e.g. "August 2026"
  year: number;
  month: number;
  transactions: JournalTransaction[];
  totalsByCurrency: Map<
    string,
    { income: number; expenses: number; net: number; count: number }
  >;
}

export function formatMonthKeyLabel(monthKey: string): string {
  const parts = monthKey.split("-");
  const year = parseInt(parts[0] ?? "", 10);
  const month = parseInt(parts[1] ?? "", 10);
  if (
    !Number.isNaN(year) &&
    !Number.isNaN(month) &&
    month >= 1 &&
    month <= 12
  ) {
    return `${MONTH_NAMES[month - 1]} ${year}`;
  }
  return monthKey;
}

export function groupTransactionsByMonth(
  transactions: JournalTransaction[],
  order: "desc" | "asc" = "desc",
): MonthTransactionGroup[] {
  const groupsMap = new Map<string, JournalTransaction[]>();

  for (const tx of transactions) {
    const monthKey = tx.date.slice(0, 7);
    const list = groupsMap.get(monthKey);
    if (list) {
      list.push(tx);
    } else {
      groupsMap.set(monthKey, [tx]);
    }
  }

  const sortedMonthKeys = Array.from(groupsMap.keys()).sort((a, b) =>
    order === "desc" ? b.localeCompare(a) : a.localeCompare(b),
  );

  return sortedMonthKeys.map((monthKey) => {
    const parts = monthKey.split("-");
    const year = parseInt(parts[0] ?? "0", 10);
    const month = parseInt(parts[1] ?? "0", 10);
    const rawTxs = groupsMap.get(monthKey) ?? [];

    const sortedTxs = [...rawTxs].sort((a, b) => {
      const cmp =
        order === "desc"
          ? b.date.localeCompare(a.date)
          : a.date.localeCompare(b.date);
      if (cmp !== 0) return cmp;
      return order === "desc"
        ? b.lineNumber - a.lineNumber
        : a.lineNumber - b.lineNumber;
    });

    const totalsByCurrency = new Map<
      string,
      { income: number; expenses: number; net: number; count: number }
    >();

    for (const tx of sortedTxs) {
      for (const p of tx.postings) {
        if (!p.hasAmount || !p.currency) continue;
        let tot = totalsByCurrency.get(p.currency);
        if (!tot) {
          tot = { income: 0, expenses: 0, net: 0, count: 0 };
          totalsByCurrency.set(p.currency, tot);
        }
        tot.count += 1;
        const root = classifyAccount(p.account);
        if (root === "income") {
          tot.income += Math.abs(p.amount);
          tot.net += Math.abs(p.amount);
        } else if (root === "expenses") {
          tot.expenses += Math.max(0, p.amount);
          tot.net -= Math.max(0, p.amount);
        }
      }
    }

    return {
      monthKey,
      label: formatMonthKeyLabel(monthKey),
      year,
      month,
      transactions: sortedTxs,
      totalsByCurrency,
    };
  });
}

export interface MonthlyCashflowPoint {
  monthKey: string;
  label: string;
  shortLabel: string;
  year: number;
  month: number;
  income: number;
  expenses: number;
  net: number;
  currency: string;
  txCount: number;
}

export function computeMonthlyCashflow(
  transactions: JournalTransaction[],
  currency: string,
  order: "asc" | "desc" = "asc",
): MonthlyCashflowPoint[] {
  const groups = groupTransactionsByMonth(transactions, order);

  return groups.map((g) => {
    const curTotals = g.totalsByCurrency.get(currency) ?? {
      income: 0,
      expenses: 0,
      net: 0,
      count: 0,
    };
    const shortMonth =
      g.month >= 1 && g.month <= 12
        ? (MONTH_NAMES[g.month - 1]?.slice(0, 3) ?? g.monthKey)
        : g.monthKey;
    const shortLabel = `${shortMonth} '${g.year.toString().slice(2)}`;
    return {
      monthKey: g.monthKey,
      label: g.label,
      shortLabel,
      year: g.year,
      month: g.month,
      income: curTotals.income,
      expenses: curTotals.expenses,
      net: curTotals.income - curTotals.expenses,
      currency,
      txCount: g.transactions.filter((tx) =>
        tx.postings.some((p) => p.currency === currency),
      ).length,
    };
  });
}
