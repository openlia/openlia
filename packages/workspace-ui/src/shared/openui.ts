import { createParser } from "@openuidev/lang-core";
import { fromMarkdown } from "mdast-util-from-markdown";
import { validateCalendarProps } from "./calendar";
import { openliaOpenUISchema, openUIPropOrder } from "./openuiSchema";

export interface MarkdownOpenUIBlock {
  code: string;
  startLine: number;
  endLine: number;
}

interface Token {
  text: string;
  start: number;
  end: number;
  kind: "string" | "word" | "punct";
}

class OpenUIArgumentError extends Error {
  constructor(readonly diagnostic: OpenUIDiagnostic) {
    super(diagnostic.message);
  }
}

// Scan once, never interpreting calls or delimiters inside strings/comments.
function tokens(source: string): Token[] {
  const result: Token[] = [];
  for (let i = 0; i < source.length; ) {
    const start = i;
    const ch = source.charAt(i);
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "#" || source.slice(i, i + 2) === "//") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i++] === ch) {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("Unterminated OpenUI string");
      result.push({
        text: source.slice(start, i),
        start,
        end: i,
        kind: "string",
      });
    } else if (/[A-Za-z0-9_$.-]/.test(ch)) {
      const number = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(
        source.slice(i),
      );
      if (number) i += number[0].length;
      else
        while (i < source.length && /[A-Za-z0-9_$.-]/.test(source.charAt(i)))
          i++;
      result.push({
        text: source.slice(start, i),
        start,
        end: i,
        kind: "word",
      });
    } else {
      i++;
      result.push({ text: ch, start, end: i, kind: "punct" });
    }
  }
  return result;
}

function splitArgs(source: string): string[] {
  const list = tokens(source);
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const args: string[] = [];
  let start = 0;
  for (const token of list) {
    if (token.kind !== "punct") continue;
    if (["(", "[", "{"].includes(token.text)) stack.push(token.text);
    else if (pairs[token.text]) {
      if (stack.pop() !== pairs[token.text])
        throw new Error("Mismatched OpenUI delimiters");
    } else if (token.text === "," && stack.length === 0) {
      const arg = source.slice(start, token.start).trim();
      if (!tokens(arg).length) throw new Error("Missing OpenUI argument");
      args.push(arg);
      start = token.end;
    }
  }
  if (stack.length) throw new Error("Unclosed OpenUI delimiter");
  const tail = source.slice(start).trim();
  if (tokens(tail).length) args.push(tail);
  return args;
}

function literal(source: string): unknown {
  const list = tokens(source);
  let pos = 0;
  const take = (text: string) => {
    if (list[pos]?.text !== text)
      throw new Error(`Expected '${text}' in table literal`);
    pos++;
  };
  const value = (): unknown => {
    const token = list[pos++];
    if (!token) throw new Error("Incomplete table literal");
    if (token.kind === "string") {
      if (token.text[0] === '"') return JSON.parse(token.text);
      return token.text
        .slice(1, -1)
        .replace(
          /\\(['"\\nrt])/g,
          (_, c: string) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? c,
        );
    }
    if (token.text === "[") {
      const items: unknown[] = [];
      while (list[pos]?.text !== "]") {
        items.push(value());
        if (list[pos]?.text === "]") break;
        take(",");
      }
      take("]");
      return items;
    }
    if (token.text === "{") {
      const item: Record<string, unknown> = Object.create(null);
      while (list[pos]?.text !== "}") {
        const key = list[pos++];
        if (!key || (key.kind !== "string" && key.kind !== "word"))
          throw new Error("Expected table object key");
        const name =
          key.kind === "string" ? String(literal(key.text)) : key.text;
        if (Object.hasOwn(item, name))
          throw new Error(`Duplicate table key '${name}'`);
        take(":");
        item[name] = value();
        if (list[pos]?.text === "}") break;
        take(",");
      }
      take("}");
      return item;
    }
    if (token.text === "null") return null;
    if (token.text === "true") return true;
    if (token.text === "false") return false;
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token.text)) {
      const number = Number(token.text);
      if (!Number.isFinite(number))
        throw new Error("Table numbers must be finite");
      return number;
    }
    throw new Error("Row tables require literal columns, rows, and title");
  };
  const parsed = value();
  if (pos !== list.length)
    throw new Error("Unexpected content after table literal");
  return parsed;
}

function rowTable(args: { key?: string; value: string }[]): string | null {
  const named = args.some((arg) => arg.key);
  const fields = new Map(
    args.flatMap((arg) => (arg.key ? [[arg.key, arg.value] as const] : [])),
  );
  if (!(named ? fields.has("rows") : args.length >= 2)) return null;
  if (
    named &&
    args.some(
      (arg) => !arg.key || !["title", "columns", "rows"].includes(arg.key),
    )
  )
    throw new Error("Row Table accepts only title, columns, and rows");
  if (!named && args.length > 3)
    throw new Error("Too many row Table arguments");
  const columns = literal(
    named ? (fields.get("columns") ?? "") : (args[0]?.value ?? ""),
  );
  const rows = literal((named ? fields.get("rows") : args[1]?.value) ?? "");
  if (!Array.isArray(columns) || !Array.isArray(rows))
    throw new Error("Table columns and rows must be arrays");
  const cols = columns.map((column) => {
    if (
      !column ||
      typeof column !== "object" ||
      typeof column.key !== "string" ||
      typeof column.label !== "string"
    )
      throw new Error("Table columns require string key and label");
    const cells = rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new Error("Table rows must be objects");
      const cell = row[column.key] ?? "";
      if (!["string", "number", "boolean"].includes(typeof cell))
        throw new Error("Table cells must be scalar values");
      return typeof cell === "boolean" ? String(cell) : cell;
    });
    return `Col(${JSON.stringify(column.label)}, ${JSON.stringify(cells)})`;
  });
  const table = `Table([${cols.join(", ")}])`;
  const titleSource = named ? fields.get("title") : args[2]?.value;
  if (titleSource === undefined) return table;
  const title = literal(titleSource);
  if (typeof title !== "string")
    throw new Error("Table title must be a string");
  return `Card([CardHeader(${JSON.stringify(title)}), ${table}])`;
}

function transform(source: string): string {
  const list = tokens(source);
  let out = "";
  let cursor = 0;
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (!token) continue;
    if (
      token.kind !== "word" ||
      !/^[A-Z]\w*$/.test(token.text) ||
      list[i - 1]?.text === "@" ||
      list[i + 1]?.text !== "("
    )
      continue;
    let depth = 1;
    let end = i + 2;
    for (; end < list.length && depth; end++) {
      if (list[end]?.kind !== "punct") continue;
      if (list[end]?.text === "(") depth++;
      if (list[end]?.text === ")") depth--;
    }
    if (depth) throw new Error(`Unclosed ${token.text} call`);
    const close = list[end - 1];
    const open = list[i + 1];
    if (!close || !open) throw new Error(`Incomplete ${token.text} call`);
    const inner = source.slice(open.end, close.start);
    const args = splitArgs(inner).map((arg) => {
      const ts = tokens(arg);
      return ts[0]?.kind === "word" && ts[1]?.text === ":"
        ? { key: ts[0].text, value: arg.slice(ts[1].end).trim() }
        : { value: arg };
    });
    const keys = args.flatMap((arg) => (arg.key ? [arg.key] : []));
    if (new Set(keys).size !== keys.length)
      throw new OpenUIArgumentError({
        code: "duplicate-argument",
        component: token.text,
        message: `Duplicate named argument in ${token.text}`,
        hint: "Specify each named argument only once.",
      });
    let replacement = token.text === "Table" ? rowTable(args) : null;
    if (replacement === null) {
      if (keys.length) {
        if (keys.length !== args.length)
          throw new OpenUIArgumentError({
            code: "mixed-arguments",
            component: token.text,
            message: "Do not mix named and positional arguments",
            hint: "Prefer all named arguments in this call.",
          });
        const order = openUIPropOrder[token.text];
        if (!order)
          throw new OpenUIArgumentError({
            code: "unknown-component",
            component: token.text,
            message: `Unknown component '${token.text}'`,
            hint: "Call openui_describe without a component to discover supported names.",
          });
        const positional: string[] = [];
        for (const arg of args) {
          const index = order.indexOf(arg.key ?? "");
          if (index < 0)
            throw new OpenUIArgumentError({
              code: "unknown-property",
              component: token.text,
              path: `/${arg.key}`,
              message: `Unknown ${token.text} argument '${arg.key}'`,
              hint: `Allowed arguments: ${order.join(", ")}. Use openui_describe for types and required fields.`,
            });
          while (positional.length <= index) positional.push("null");
          positional[index] = transform(arg.value);
        }
        replacement = `${token.text}(${positional.join(", ")})`;
      } else replacement = `${token.text}(${transform(inner)})`;
    }
    out += source.slice(cursor, token.start) + replacement;
    cursor = close.end;
    i = end - 1;
  }
  return out + source.slice(cursor);
}

export function normalizeOpenUIProgram(source: string): string {
  const normalized = transform(source);
  const list = tokens(normalized);
  const first = list[0];
  if (!first) return normalized;
  // Existing assignment programs are left intact; only a leading bare expression is wrapped.
  if (list[1]?.text === "=") return normalized;
  return `${normalized.slice(0, first.start)}root = ${normalized.slice(first.start)}`;
}

const parser = createParser(openliaOpenUISchema);

export interface OpenUIDiagnostic {
  code: string;
  message: string;
  component?: string;
  path?: string;
  statementId?: string;
  hint?: string;
}

/** Complete-document validation, unlike the upstream streaming parser. */
export function openUIDiagnostics(source: string): OpenUIDiagnostic[] {
  try {
    const result = parser.parse(normalizeOpenUIProgram(source));
    const diagnostics: OpenUIDiagnostic[] = result.meta.errors.map((error) => ({
      ...error,
      hint: `Use openui_describe for ${error.component} and check the field type, required arguments, and allowed values.`,
    }));
    if (result.meta.incomplete)
      diagnostics.push({
        code: "incomplete-program",
        message: "OpenUI program is incomplete",
      });
    if (result.meta.unresolved.length)
      diagnostics.push({
        code: "unresolved-reference",
        message: `Unresolved references: ${result.meta.unresolved.join(", ")}`,
        hint: "Define referenced values in this block; blocks do not share variables.",
      });
    if (!result.root && !diagnostics.length)
      diagnostics.push({
        code: "missing-root",
        message: "Missing required root statement",
      });
    // JSON Schema cannot express calendar chronology, IANA zones, or unique IDs.
    // Validate resolved props as well, including nested and referenced calendars.
    const visited = new WeakSet<object>();
    const validateCalendars = (value: unknown): void => {
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (
        "typeName" in value &&
        value.typeName === "Calendar" &&
        "props" in value
      ) {
        const checked = validateCalendarProps(value.props);
        if (!checked.success)
          for (const issue of checked.error.issues)
            diagnostics.push({
              code: "invalid-calendar",
              component: "Calendar",
              path: `/${issue.path.join("/")}`,
              message: issue.message,
              hint: "Use either a Remind source or read-only inline events. Inline IDs must be unique, dates and timezones valid, and end after start.",
            });
      }
      for (const child of Object.values(value)) validateCalendars(child);
    };
    validateCalendars(result.root);
    return diagnostics;
  } catch (error) {
    if (error instanceof OpenUIArgumentError) return [error.diagnostic];
    return [
      {
        code: "normalization-error",
        message: error instanceof Error ? error.message : String(error),
        hint: "Use schema-named arguments without mixing positional arguments. Check delimiters and literal table data; use openui_describe for exact properties.",
      },
    ];
  }
}

export function openUIErrors(source: string): string[] {
  return openUIDiagnostics(source).map(
    (error) => `${error.code}: ${error.message}`,
  );
}

export function extractMarkdownOpenUIBlocks(
  markdown: string,
): MarkdownOpenUIBlock[] {
  const blocks: MarkdownOpenUIBlock[] = [];
  const visit = (
    node:
      | ReturnType<typeof fromMarkdown>
      | ReturnType<typeof fromMarkdown>["children"][number],
  ): void => {
    if (
      node.type === "code" &&
      /^(?:openui|openui-lang)$/i.test(node.lang ?? "")
    ) {
      blocks.push({
        code: node.value,
        startLine: (node.position?.start.line ?? 0) + 1,
        endLine: node.position?.end.line ?? 0,
      });
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(fromMarkdown(markdown));
  return blocks;
}
