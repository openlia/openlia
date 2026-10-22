import {
  type SankeyLink as D3SankeyLink,
  type SankeyNode as D3SankeyNode,
  sankey,
  sankeyJustify,
  sankeyLinkHorizontal,
} from "d3-sankey";
import { useMemo, useState } from "react";
import type { SankeyLink, SankeyNode } from "./parser";
import { formatCurrency } from "./parser";

export type LayoutNode = D3SankeyNode<SankeyNode, SankeyLink>;
export type LayoutLink = D3SankeyLink<SankeyNode, SankeyLink>;

interface HoverInfo {
  title: string;
  subtitle: string;
  x: number;
  y: number;
}

export function SankeyDiagram({
  nodes,
  links,
  currency,
}: {
  nodes: SankeyNode[];
  links: SankeyLink[];
  currency: string;
}) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredLinkId, setHoveredLinkId] = useState<number | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);

  const svgWidth = 920;
  const maxColumnNodes = useMemo(() => {
    const counts = { income: 0, pool: 0, outflow: 0 };
    for (const n of nodes) {
      if (n.type === "income") counts.income++;
      else if (n.type === "pool") counts.pool++;
      else counts.outflow++;
    }
    return Math.max(counts.income, counts.pool, counts.outflow, 1);
  }, [nodes]);
  const svgHeight = Math.max(360, maxColumnNodes * 44 + 70);

  const { layoutNodes, layoutLinks } = useMemo(() => {
    if (nodes.length === 0 || links.length === 0) {
      return { layoutNodes: [], layoutLinks: [] };
    }

    try {
      const sankeyGenerator = sankey<SankeyNode, SankeyLink>()
        .nodeId((d) => d.id)
        .nodeWidth(170)
        .nodePadding(18)
        .extent([
          [40, 45],
          [svgWidth - 40, svgHeight - 25],
        ])
        .nodeAlign(sankeyJustify);

      const graph = sankeyGenerator({
        nodes: nodes.map((n) => ({ ...n })),
        links: links.map((l) => ({ ...l })),
      });

      return { layoutNodes: graph.nodes, layoutLinks: graph.links };
    } catch {
      return { layoutNodes: [], layoutLinks: [] };
    }
  }, [nodes, links, svgHeight]);

  const pathGenerator = useMemo(() => {
    return sankeyLinkHorizontal<SankeyNode, SankeyLink>();
  }, []);

  const getNodeColor = (type: SankeyNode["type"]) => {
    switch (type) {
      case "income":
        return { fill: "#059669", stroke: "#10b981", text: "#ecfdf5" };
      case "pool":
        return { fill: "#0284c7", stroke: "#06b6d4", text: "#f0f9ff" };
      case "expense":
        return { fill: "#e11d48", stroke: "#f43f5e", text: "#fff1f2" };
      case "savings":
        return { fill: "#7c3aed", stroke: "#a78bfa", text: "#f5f3ff" };
      default:
        return { fill: "#475569", stroke: "#64748b", text: "#f8fafc" };
    }
  };

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-base-content/10 bg-base-200/50 p-4 shadow-xs">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/70">
          Money Flow (Sankey Diagram)
        </h3>
        <div className="flex items-center gap-2 text-[11px] text-base-content/50">
          <span className="badge badge-sm badge-neutral">{currency}</span>
          <span>Hover over nodes or flow ribbons for breakdown</span>
        </div>
      </div>

      <div className="relative w-full overflow-x-auto">
        {layoutLinks.length === 0 && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-xs text-base-content/50">
            No money flow recorded for {currency}.
          </div>
        )}
        <svg
          aria-label="Money Flow Sankey Diagram"
          className="mx-auto block select-none"
          height={svgHeight}
          role="img"
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          width="100%"
        >
          <defs>
            {/* Gradients for links */}
            {layoutLinks.map((link, idx) => {
              const sNode = link.source as LayoutNode;
              const tNode = link.target as LayoutNode;
              const sColor = getNodeColor(sNode.type).stroke;
              const tColor = getNodeColor(tNode.type).stroke;
              const gradId = `d3-sankey-grad-${idx}`;
              return (
                <linearGradient
                  id={gradId}
                  key={gradId}
                  x1="0%"
                  x2="100%"
                  y1="0%"
                  y2="0%"
                >
                  <stop offset="0%" stopColor={sColor} />
                  <stop offset="100%" stopColor={tColor} />
                </linearGradient>
              );
            })}
          </defs>

          {/* Column Header Titles */}
          <text
            className="fill-base-content/60 font-semibold"
            fontSize="11"
            letterSpacing="1"
            x={40}
            y="24"
          >
            INFLOW (SOURCES)
          </text>
          <text
            className="fill-base-content/60 font-semibold"
            fontSize="11"
            letterSpacing="1"
            x={380}
            y="24"
          >
            ACCOUNT POOL / RAILS
          </text>
          <text
            className="fill-base-content/60 font-semibold"
            fontSize="11"
            letterSpacing="1"
            x={690}
            y="24"
          >
            OUTFLOW / ALLOCATIONS
          </text>

          {/* Links / Flow Ribbons */}
          <g className="links">
            {layoutLinks.map((link, idx) => {
              const sNode = link.source as LayoutNode;
              const tNode = link.target as LayoutNode;
              const isNodeHovered =
                hoveredNodeId === sNode.id || hoveredNodeId === tNode.id;
              const isLinkHovered = hoveredLinkId === idx;
              const isActive = isLinkHovered || isNodeHovered;
              const opacity =
                hoveredLinkId !== null || hoveredNodeId !== null
                  ? isActive
                    ? 0.75
                    : 0.15
                  : 0.45;
              const gradId = `d3-sankey-grad-${idx}`;
              const pathD = pathGenerator(link);

              if (!pathD) return null;

              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: Interactive SVG flow element
                <path
                  key={gradId}
                  className="transition-opacity duration-150 cursor-pointer"
                  d={pathD}
                  fill="none"
                  onMouseEnter={(e) => {
                    setHoveredLinkId(idx);
                    setHoverInfo({
                      title: `${sNode.name} → ${tNode.name}`,
                      subtitle: formatCurrency(link.value, currency),
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }}
                  onMouseMove={(e) => {
                    setHoverInfo((prev) =>
                      prev ? { ...prev, x: e.clientX, y: e.clientY } : null,
                    );
                  }}
                  onMouseLeave={() => {
                    setHoveredLinkId(null);
                    setHoverInfo(null);
                  }}
                  stroke={`url(#${gradId})`}
                  strokeOpacity={opacity}
                  strokeWidth={Math.max(3, link.width ?? 0)}
                />
              );
            })}
          </g>

          {/* Nodes */}
          <g className="nodes">
            {layoutNodes.map((node) => {
              const colors = getNodeColor(node.type);
              const isHovered = hoveredNodeId === node.id;
              const x0 = node.x0 ?? 0;
              const y0 = node.y0 ?? 0;
              const x1 = node.x1 ?? 0;
              const y1 = node.y1 ?? 0;
              const width = Math.max(20, x1 - x0);
              const height = Math.max(20, y1 - y0);
              const isCompact = height < 34;

              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: Interactive SVG node element
                <g
                  key={node.id}
                  className="cursor-pointer transition-transform duration-150"
                  onMouseEnter={(e) => {
                    setHoveredNodeId(node.id);
                    setHoverInfo({
                      title: node.name,
                      subtitle: `${formatCurrency(node.value ?? 0, currency)} (${node.type})`,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }}
                  onMouseMove={(e) => {
                    setHoverInfo((prev) =>
                      prev ? { ...prev, x: e.clientX, y: e.clientY } : null,
                    );
                  }}
                  onMouseLeave={() => {
                    setHoveredNodeId(null);
                    setHoverInfo(null);
                  }}
                >
                  <rect
                    fill={colors.fill}
                    filter={
                      isHovered
                        ? "drop-shadow(0 2px 8px rgba(0,0,0,0.3))"
                        : undefined
                    }
                    height={height}
                    rx="6"
                    ry="6"
                    stroke={colors.stroke}
                    strokeWidth={isHovered ? 2 : 1}
                    width={width}
                    x={x0}
                    y={y0}
                  />

                  {isCompact ? (
                    <text
                      className="font-medium"
                      dominantBaseline="central"
                      fill={colors.text}
                      fontSize="10"
                      x={x0 + 8}
                      y={y0 + height / 2}
                    >
                      {node.name.length > 13
                        ? `${node.name.slice(0, 12)}…`
                        : node.name}{" "}
                      · {formatCurrency(node.value ?? 0, currency)}
                    </text>
                  ) : (
                    <>
                      {/* Node label text */}
                      <text
                        className="font-medium"
                        fill={colors.text}
                        fontSize={height > 38 ? "12" : "11"}
                        x={x0 + 10}
                        y={y0 + (height > 38 ? 16 : 14)}
                      >
                        {node.name.length > 20
                          ? `${node.name.slice(0, 19)}…`
                          : node.name}
                      </text>

                      {/* Node amount text */}
                      <text
                        className="font-bold opacity-90"
                        fill={colors.text}
                        fontSize={height > 38 ? "11" : "10"}
                        x={x0 + 10}
                        y={y0 + (height > 38 ? 32 : height - 5)}
                      >
                        {formatCurrency(node.value ?? 0, currency)}
                      </text>
                    </>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* Floating hover tooltip */}
      {hoverInfo && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-lg bg-neutral px-3 py-1.5 text-xs text-neutral-content shadow-xl"
          style={{
            left: `${hoverInfo.x}px`,
            top: `${hoverInfo.y - 10}px`,
          }}
        >
          <div className="font-semibold">{hoverInfo.title}</div>
          <div className="text-[11px] opacity-80">{hoverInfo.subtitle}</div>
        </div>
      )}
    </div>
  );
}
