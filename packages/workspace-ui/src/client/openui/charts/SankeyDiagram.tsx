import { defineComponent } from "@openuidev/react-lang";
import { sankey, sankeyLinkHorizontal } from "d3-sankey";
import { useEffect, useId, useState } from "react";
import {
  chartOpenUIProps,
  type NormalizedSankeyData,
  parseExternalSankeyJson,
  type SankeyData,
  sankeyDataSchema,
} from "../../../shared/charts";
import { httpWorkspaceApi } from "../../api";
import { resolveOpenUISourcePath, useOpenLiaOpenUI } from "../context";
import { colorForKey } from "./palette";

type ColorNode = {
  id: string;
  colorKey?: string | undefined;
  color?: string | undefined;
};

const nodeColor = (node: ColorNode) =>
  node.color ?? colorForKey(node.colorKey ?? node.id);

export function layoutSankey(
  nodes: SankeyData["nodes"],
  links: SankeyData["links"],
  height = 360,
) {
  const parsed = sankeyDataSchema.safeParse({ nodes, links });
  if (!parsed.success)
    throw new Error(
      "Invalid Sankey data or graph exceeds 200 nodes / 400 links.",
    );
  const ids = new Set(nodes.map((node) => node.id));
  if (
    ids.size !== nodes.length ||
    links.some((link) => !ids.has(link.source) || !ids.has(link.target))
  )
    throw new Error(
      "Sankey nodes must have unique IDs and every link must reference existing nodes.",
    );
  const positive = links.filter((link) => link.value > 0);
  if (!positive.length) return null;
  const used = new Set(positive.flatMap((link) => [link.source, link.target]));
  try {
    return sankey<
      {
        id: string;
        label: string;
        colorKey?: string | undefined;
        color?: string | undefined;
      },
      {
        source: string;
        target: string;
        value: number;
        exact?: string | undefined;
      }
    >()
      .nodeId((node) => node.id)
      .nodeWidth(18)
      .nodePadding(14)
      .extent([
        [120, 12],
        [780, height - 12],
      ])({
      nodes: nodes
        .filter((node) => used.has(node.id))
        .map((node) => ({ ...node })),
      links: positive.map((link) => ({ ...link })),
    });
  } catch {
    throw new Error(
      "This Sankey graph contains unsupported cycles or cannot be laid out. Use a staged graph or the data table.",
    );
  }
}

export function SankeyDiagramView({
  nodes,
  links,
  title = "Flow diagram",
  unit = "",
  caption,
  height = 360,
  loading = false,
  error: propError,
  sourcePath,
  onOpenSource,
}: {
  nodes: SankeyData["nodes"];
  links: SankeyData["links"];
  title?: string | undefined;
  unit?: string | undefined;
  caption?: string | undefined;
  height?: number | undefined;
  loading?: boolean | undefined;
  error?: string | undefined;
  sourcePath?: string | undefined;
  onOpenSource?: (() => void) | undefined;
}) {
  const id = useId();
  const gradientId = `sankey-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  let graph: ReturnType<typeof layoutSankey> = null;
  let error = propError ?? "";
  if (!loading && !error) {
    try {
      graph = layoutSankey(nodes, links, height);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Invalid Sankey graph";
    }
  }
  const label = (key: string) =>
    nodes.find((node) => node.id === key)?.label ?? key;
  const tableLinks = links.map((link, position) => ({
    ...link,
    id: `${link.source}:${link.target}:${position}`,
  }));
  return (
    <section
      aria-labelledby={id}
      aria-busy={loading}
      className="rounded-xl border border-base-content/10 p-4 space-y-3 min-w-0"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id={id} className="font-semibold">
            {title}
            {unit ? ` · ${unit}` : ""}
          </h3>
          {sourcePath && (
            <p className="text-xs opacity-60">Source: {sourcePath}</p>
          )}
        </div>
        {onOpenSource && (
          <button
            type="button"
            className="btn btn-xs btn-outline"
            onClick={onOpenSource}
          >
            Open JSON source
          </button>
        )}
      </header>
      {caption && <p className="text-xs opacity-70">{caption}</p>}
      {loading ? (
        <p role="status" className="text-sm">
          Loading Sankey diagram…
        </p>
      ) : error ? (
        <p role="alert" className="text-error text-sm">
          {error}
        </p>
      ) : !graph ? (
        <p role="status">No positive flows in this scope.</p>
      ) : (
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 900 ${height}`}
            className="w-full min-w-[540px]"
            role="img"
            aria-label={`${title}. All flows are also listed in the exact data table.`}
          >
            <defs>
              {graph.links.map((link) => {
                const source = link.source as ColorNode & { x1: number };
                const target = link.target as ColorNode & { x0: number };
                return (
                  <linearGradient
                    key={link.index}
                    id={`${gradientId}-${link.index}`}
                    gradientUnits="userSpaceOnUse"
                    x1={source.x1}
                    y1={link.y0}
                    x2={target.x0}
                    y2={link.y1}
                  >
                    <stop offset="0%" stopColor={nodeColor(source)} />
                    <stop offset="100%" stopColor={nodeColor(target)} />
                  </linearGradient>
                );
              })}
            </defs>
            {graph.links.map((link) => (
              <path
                key={`${link.index}`}
                d={sankeyLinkHorizontal()(link) ?? ""}
                fill="none"
                stroke={`url(#${gradientId}-${link.index})`}
                strokeOpacity="0.7"
                opacity="0.7"
                className="transition-opacity hover:opacity-100"
                strokeWidth={Math.max(1, link.width ?? 0)}
              >
                <title>
                  {(link.source as { label: string }).label} →{" "}
                  {(link.target as { label: string }).label}:{" "}
                  {link.exact ?? link.value} {unit}
                </title>
              </path>
            ))}
            {graph.nodes.map((node) => (
              <g key={node.id}>
                <rect
                  x={node.x0}
                  y={node.y0}
                  width={18}
                  height={Math.max(1, (node.y1 ?? 0) - (node.y0 ?? 0))}
                  fill={nodeColor(node)}
                  data-color-key={node.colorKey ?? node.id}
                >
                  <title>{node.label}</title>
                </rect>
                <text
                  x={
                    (node.x0 ?? 0) < 450
                      ? (node.x1 ?? 0) + 6
                      : (node.x0 ?? 0) - 6
                  }
                  y={((node.y0 ?? 0) + (node.y1 ?? 0)) / 2}
                  dy="0.35em"
                  textAnchor={(node.x0 ?? 0) < 450 ? "start" : "end"}
                  fill="currentColor"
                  fontSize="11"
                >
                  {node.label.length > 32
                    ? `${node.label.slice(0, 29)}…`
                    : node.label}
                </text>
              </g>
            ))}
          </svg>
        </div>
      )}
      {!loading && !error && tableLinks.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm">Exact data table</summary>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <caption className="sr-only">{title} flows</caption>
              <thead>
                <tr>
                  <th scope="col">From</th>
                  <th scope="col">To</th>
                  <th scope="col">Value {unit}</th>
                </tr>
              </thead>
              <tbody>
                {tableLinks.map((link) => (
                  <tr key={link.id}>
                    <td>{label(link.source)}</td>
                    <td>{label(link.target)}</td>
                    <td>{link.exact ?? String(link.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

export function SankeyDiagramContainer({
  nodes,
  links,
  source,
  title,
  unit,
  caption,
  height,
}: {
  nodes?: SankeyData["nodes"] | null | undefined;
  links?: SankeyData["links"] | null | undefined;
  source?: string | null | undefined;
  title?: string | null | undefined;
  unit?: string | null | undefined;
  caption?: string | null | undefined;
  height?: number | null | undefined;
}) {
  const {
    api = httpWorkspaceApi,
    filePath,
    scope = "workspace",
    onNavigateLink,
  } = useOpenLiaOpenUI();
  const [externalData, setExternalData] = useState<NormalizedSankeyData | null>(
    null,
  );
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(Boolean(source));

  const resolvedSource = source
    ? resolveOpenUISourcePath(source, filePath, scope)
    : null;
  const resolvedSourcePath = resolvedSource?.path;
  const resolvedSourceScope = resolvedSource?.scope;

  useEffect(() => {
    if (!resolvedSourcePath || !resolvedSourceScope) {
      setExternalData(null);
      setLoadError("");
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError("");
    api
      .loadFile(resolvedSourcePath, resolvedSourceScope)
      .then((file) => {
        if (!active) return;
        const parsed = parseExternalSankeyJson(file.content);
        setExternalData(parsed);
      })
      .catch((caught) => {
        if (!active) return;
        setExternalData(null);
        setLoadError(
          caught instanceof Error
            ? caught.message
            : "Failed to load Sankey JSON file.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, resolvedSourcePath, resolvedSourceScope]);

  if (resolvedSource) {
    return (
      <SankeyDiagramView
        nodes={externalData?.nodes ?? []}
        links={externalData?.links ?? []}
        title={title ?? externalData?.title ?? "Flow diagram"}
        unit={unit ?? externalData?.unit ?? ""}
        caption={caption ?? externalData?.caption}
        height={height ?? externalData?.height ?? 360}
        loading={loading}
        error={loadError || undefined}
        sourcePath={resolvedSource.path}
        onOpenSource={
          onNavigateLink ? () => onNavigateLink(resolvedSource.path) : undefined
        }
      />
    );
  }

  return (
    <SankeyDiagramView
      nodes={nodes ?? []}
      links={links ?? []}
      title={title ?? "Flow diagram"}
      unit={unit ?? ""}
      caption={caption ?? undefined}
      height={height ?? 360}
    />
  );
}

export const ChartSankey = defineComponent({
  name: "ChartSankey",
  description:
    "Directed, non-negative Sankey flow diagram with cycle validation and an accessible exact data table. Supports inline nodes+links or source: '*.json'.",
  props: chartOpenUIProps.ChartSankey,
  component: ({ props }) => <SankeyDiagramContainer {...props} />,
});

export const SankeyDiagram = defineComponent({
  name: "SankeyDiagram",
  description:
    "Reusable directed, non-negative Sankey graph with validation and an accessible exact table (alias for ChartSankey).",
  props: chartOpenUIProps.SankeyDiagram,
  component: ({ props }) => <SankeyDiagramContainer {...props} />,
});
