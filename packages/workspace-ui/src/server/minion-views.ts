/** Read-only runtime views: never import or run workspace app code. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, opendirSync } from "node:fs";
import { join, relative } from "node:path";
import YAML from "yaml";
import {
  minionQuerySchema,
  minionViewsSchema,
  minionViewSettingsSchema,
  type MinionView,
} from "../shared/minionViews";
import { CalendarService } from "./calendar";
import { safeMinionPath } from "./minion-distribution";
import type { WorkspaceService } from "./workspace";

const blocked = new Set([
  "config.json",
  "context.json",
  "data.views.json",
  "secrets.json",
  "credentials.json",
  "pending",
  "cache",
  "caches",
  "state",
  "logs",
  "uploads",
  "node_modules",
  "tests",
  "scripts",
  "__pycache__",
]);
type Row = Record<string, unknown>;
function boundedEntries(path: string, max: number) {
  const directory = opendirSync(path);
  const entries = [];
  try {
    for (
      let entry = directory.readSync();
      entry;
      entry = directory.readSync()
    ) {
      if (entries.length >= max)
        throw new Error("View directory exceeds scan limits");
      entries.push(entry);
    }
  } finally {
    directory.closeSync();
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
export class MinionViewService {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly calendar = new CalendarService(workspace),
  ) {}

  private app(id: string) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("Invalid Minion id");
    return safeMinionPath(this.workspace.workspaceRoot, `minions/${id}`);
  }

  describe(id: string) {
    this.app(id);
    const contractPath = safeMinionPath(this.app(id), "data.views.json");
    if (lstatSync(contractPath).size > 65536)
      throw new Error("View declaration exceeds 64 KiB");
    const contract = this.workspace.read(`minions/${id}/data.views.json`);
    if (Buffer.byteLength(contract.content) > 65536)
      throw new Error("View declaration exceeds 64 KiB");
    const definition = minionViewsSchema.parse(JSON.parse(contract.content));
    for (const view of definition.views) this.path(id, view);
    let settings = minionViewSettingsSchema.parse({});
    try {
      const config = JSON.parse(
        this.workspace.read(`minions/${id}/config.json`).content,
      );
      settings = minionViewSettingsSchema.parse(config.data_views ?? {});
    } catch (error) {
      // A fresh app has no local participation settings. Malformed settings fail closed.
      if ((error as { code?: string }).code !== "not_found") throw error;
    }
    const ids = new Set(definition.views.map((view) => view.id));
    if (
      [...settings.briefing, ...Object.keys(settings.scopes)].some(
        (id) => !ids.has(id),
      )
    )
      throw new Error("Local settings reference an unknown data view");
    return {
      schema: 1,
      id,
      revision: contract.revision,
      views: definition.views.map((view) => ({
        ...view,
        briefing_enabled: settings.briefing.includes(view.id),
      })),
      settings,
    };
  }

  list() {
    const apps = safeMinionPath(this.workspace.workspaceRoot, "minions");
    if (!existsSync(apps)) return { schema: 1, minions: [], status: "ok" };
    const results = [];
    try {
      for (const entry of boundedEntries(apps, 200)) {
        if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name))
          continue;
        try {
          results.push({ status: "ok", ...this.describe(entry.name) });
        } catch (error) {
          results.push({
            id: entry.name,
            status: "unavailable",
            message:
              error instanceof Error ? error.message : "Unavailable view",
          });
        }
      }
    } catch {
      return { schema: 1, minions: [], status: "unavailable" };
    }
    return { schema: 1, minions: results, status: "ok" };
  }

  private path(id: string, view: MinionView) {
    if (
      view.path
        .split("/")
        .some((part) => part.startsWith(".") || blocked.has(part.toLowerCase()))
    )
      throw new Error("View selects app internals");
    return safeMinionPath(this.app(id), view.path);
  }

  async query(raw: unknown) {
    const request = minionQuerySchema.parse(raw);
    const description = this.describe(request.id);
    const view = description.views.find((item) => item.id === request.view);
    if (!view) throw new Error("Unknown data view");
    if (request.purpose === "briefing" && !view.briefing_enabled)
      throw new Error("View is not enabled for briefings in local config");
    const scope = description.settings.scopes[view.id] ?? {};
    for (const [key, value] of Object.entries(scope)) {
      if (key in request.filters && request.filters[key] !== value)
        throw new Error("Query cannot override local view scope");
    }
    const filters = { ...request.filters, ...scope };
    if (Object.keys(filters).some((key) => !view.fields.includes(key)))
      throw new Error("Filter uses an undeclared field");
    if (
      view.required_filters.some(
        (key) =>
          filters[key] === undefined ||
          filters[key] === null ||
          filters[key] === "",
      )
    )
      throw new Error("View requires explicit scope filters");
    const source = `minions/${request.id}/${view.path}`;
    const path = this.path(request.id, view);
    const hash = createHash("sha256")
      .update(description.revision)
      .update(JSON.stringify(view));
    const rows: { row: Row; source: string; id: string }[] = [];
    let files = 0;
    let bytes = 0;
    const revisions = new Map<string, string>();
    const read = (name: string) => {
      const absolute = safeMinionPath(this.app(request.id), name);
      const stat = lstatSync(absolute);
      files++;
      bytes += stat.size;
      if (!stat.isFile() || files > view.max_files || bytes > view.max_bytes)
        throw new Error("View source exceeds scan limits");
      const file = this.workspace.read(`minions/${request.id}/${name}`);
      if (Buffer.byteLength(file.content) !== stat.size)
        throw new Error("View source changed during read; retry the query");
      revisions.set(name, file.revision);
      hash.update(name).update(file.revision);
      return file.content;
    };
    if (view.reader === "calendar") {
      const result = await this.calendar.load(
        {
          source,
          from: request.from,
          to: request.to,
        },
        { maxFiles: view.max_files, maxBytes: view.max_bytes },
      );
      hash.update(result.revision);
      for (const event of result.events)
        rows.push({
          row: event as unknown as Row,
          source: event.sourcePath,
          id: event.occurrenceId,
        });
    } else if (view.reader === "json") {
      if (!view.path.endsWith(".json"))
        throw new Error("JSON reader requires a JSON file");
      let data: unknown;
      try {
        data = JSON.parse(read(view.path));
      } catch {
        throw new Error("Declared JSON data is unavailable or invalid");
      }
      if (!Array.isArray(data) || data.length > 10000)
        throw new Error("JSON view requires an array of at most 10000 records");
      data.forEach((row) => {
        if (row && typeof row === "object" && !Array.isArray(row))
          rows.push({
            row,
            source,
            id: `${source}#${createHash("sha256").update(JSON.stringify(row)).digest("hex")}`,
          });
      });
    } else {
      let entries = 0;
      const walk = (absolute: string) => {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink())
          throw new Error("Symlinks are not supported in data views");
        if (++entries > 1000)
          throw new Error("View directory exceeds scan limits");
        if (stat.isDirectory()) {
          for (const entry of boundedEntries(absolute, 1000 - entries)) {
            if (
              entry.name.startsWith(".") ||
              blocked.has(entry.name.toLowerCase())
            )
              continue;
            walk(join(absolute, entry.name));
          }
          return;
        }
        if (
          !stat.isFile() ||
          !absolute.endsWith(".md") ||
          absolute.endsWith("-template.md")
        )
          return;
        const name = relative(this.app(request.id), absolute).replaceAll(
          "\\",
          "/",
        );
        const text = read(name);
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        if (!match)
          throw new Error(
            "Missing Markdown record frontmatter in declared view",
          );
        const doc = YAML.parseDocument(match[1] ?? "", { uniqueKeys: true });
        if (doc.errors.length)
          throw new Error("Invalid Markdown frontmatter in declared view");
        const data: unknown = doc.toJS({ maxAliasCount: 0 });
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new Error("Invalid Markdown record in declared view");
        const row = { ...data } as Row;
        row.title ??= /^#\s+(.+)$/m.exec(text.slice(match[0].length))?.[1];
        rows.push({ row, source: `minions/${request.id}/${name}`, id: name });
      };
      walk(path);
    }
    let unknownDates = 0;
    const matching = rows
      .filter(({ row }) => {
        if (
          !Object.entries(filters).every(([key, value]) => row[key] === value)
        )
          return false;
        // CalendarService already selects overlapping occurrences in its calendar
        // timezone. Do not re-filter them using UTC start dates.
        if (view.reader === "calendar") return true;
        const date = String(row[view.date_field] ?? "").slice(0, 10);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(Date.parse(date)) ||
          new Date(date).toISOString().slice(0, 10) !== date
        ) {
          unknownDates++;
          return false;
        }
        return date >= request.from && date < request.to;
      })
      .sort(
        (a, b) =>
          String(a.row[view.date_field]).localeCompare(
            String(b.row[view.date_field]),
          ) || a.id.localeCompare(b.id),
      );
    const limit = Math.min(request.limit, view.max_records);
    const records = matching.slice(0, limit).map(({ row, source, id }) => {
      const fields: Row = {};
      for (const field of view.fields) {
        const value = row[field];
        // No unbounded objects, arrays, document bodies, or undeclared fields.
        if (typeof value === "string")
          fields[field] = value.slice(0, view.max_field_chars);
        else if (
          typeof value === "boolean" ||
          value === null ||
          (typeof value === "number" && Number.isFinite(value))
        )
          fields[field] = value;
      }
      return {
        id: String(view.id_field ? (row[view.id_field] ?? id) : id).slice(
          0,
          300,
        ),
        title: String(fields[view.title_field] ?? "Untitled record"),
        fields,
        source: `openlia://workspace/${source.split("/").map(encodeURIComponent).join("/")}`,
      };
    });
    const current = this.describe(request.id);
    if (
      current.revision !== description.revision ||
      JSON.stringify(current.settings) !== JSON.stringify(description.settings)
    )
      throw new Error(
        "View declaration or local scope changed during query; retry",
      );
    for (const [name, expected] of revisions) {
      if (
        this.workspace.read(`minions/${request.id}/${name}`).revision !==
        expected
      )
        throw new Error("View source changed during query; retry");
    }
    return {
      schema: 1,
      status: "ok",
      id: request.id,
      view: view.id,
      from: request.from,
      to: request.to,
      observed_at: new Date().toISOString(),
      revision: `sha256:${hash.digest("hex")}`,
      records,
      matched: matching.length,
      unknown_dates: unknownDates,
      truncated: matching.length > limit,
    };
  }
}
