import {
  defineComponent,
  useIsQueryLoading,
  type ComponentRenderProps,
} from "@openuidev/react-lang";
import {
  openuiLibrary,
  ScrollableTable,
  Table as BasicTable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeleton,
} from "@openuidev/react-ui";
import { useState } from "react";
import type { z } from "zod";
import {
  tableOpenUIOptionProps,
  type TableLayoutOptions,
  type TablePaginationOptions,
} from "../../../shared/table";

const upstreamTable = openuiLibrary.components.Table;
if (!upstreamTable) throw new Error("The upstream OpenUI Table is unavailable");

const tableProps = upstreamTable.props.extend(tableOpenUIOptionProps);
type OpenLiaTableProps = z.infer<typeof tableProps>;
type OpenLiaTableRenderProps = ComponentRenderProps<OpenLiaTableProps>;

type ColumnDefinition = {
  props?: {
    label?: string;
    data?: unknown;
  };
};

function valuesOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function externalUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

function shortUrlLabel(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com")
  )
    return "YouTube";
  return host.length > 32 ? "Open link" : host;
}

function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <span className="openlia-openui-table__expandable-text">
      <span
        className={
          expanded
            ? "openlia-openui-table__full-text"
            : "openlia-openui-table__truncated-text"
        }
      >
        {text}
      </span>{" "}
      <button
        aria-expanded={expanded}
        className="openlia-openui-table__text-toggle"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </span>
  );
}

function TextCell({
  value,
  expandLongText,
}: {
  value: string;
  expandLongText: boolean;
}) {
  const url = externalUrl(value);
  if (url) {
    const label = shortUrlLabel(url);
    return (
      <a
        aria-label={`Open ${label} in a new tab`}
        href={url.href}
        rel="noopener noreferrer"
        target="_blank"
        title={value}
      >
        {label}
      </a>
    );
  }

  if (expandLongText && value.length > 240)
    return <ExpandableText text={value} />;
  return value;
}

function TableView({ props, renderNode }: OpenLiaTableRenderProps) {
  const isQueryLoading = useIsQueryLoading();
  const pagination = (props.pagination ?? {}) as TablePaginationOptions;
  const layout = (props.layout ?? {}) as TableLayoutOptions;
  const pageSize = pagination.pageSize ?? 10;
  const paginationEnabled = pagination.enabled !== false;
  const horizontalScroll = layout.horizontalScroll !== false;
  const wrapText = layout.wrapText === true || layout.expandLongText === true;
  const [currentPage, setCurrentPage] = useState(0);
  const [showAll, setShowAll] = useState(false);

  const columns = (props.columns ?? []) as unknown as ColumnDefinition[];
  const columnDefinitions = columns
    .filter((column) => column?.props)
    .map((column, index) => ({
      key: `${column.props?.label ?? ""}:${index}`,
      label: column.props?.label ?? "",
      data: valuesOf(column.props?.data),
    }));
  const rowCount = columnDefinitions.length
    ? Math.max(...columnDefinitions.map((column) => column.data.length), 0)
    : 0;

  if (isQueryLoading && rowCount === 0)
    return (
      <TableSkeleton rows={5} columns={Math.max(columnDefinitions.length, 3)} />
    );
  if (!columnDefinitions.length) return null;

  const totalPages = Math.ceil(rowCount / pageSize);
  const showAllRows =
    !paginationEnabled || (pagination.showAllOption === true && showAll);
  const safePage = Math.min(currentPage, Math.max(0, totalPages - 1));
  const startRow = showAllRows ? 0 : safePage * pageSize;
  const endRow = showAllRows
    ? rowCount
    : Math.min(startRow + pageSize, rowCount);
  const visibleRowCount = Math.max(0, endRow - startRow);
  const canToggleAll =
    paginationEnabled &&
    pagination.showAllOption === true &&
    rowCount > pageSize;
  const canPaginate = paginationEnabled && !showAllRows && totalPages > 1;

  const tableContents = (
    <>
      <caption className="sr-only">OpenUI data table</caption>
      <TableHeader>
        <TableRow>
          {columnDefinitions.map((column) => (
            <TableHead key={column.key} scope="col">
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: visibleRowCount }, (_, visibleIndex) => {
          const rowIndex = startRow + visibleIndex;
          return (
            <TableRow key={rowIndex}>
              {columnDefinitions.map((column) => {
                const cell = column.data[rowIndex];
                const className = wrapText
                  ? "openlia-openui-table__cell openlia-openui-table__cell--wrap"
                  : "openlia-openui-table__cell";
                const content =
                  typeof cell === "object" && cell !== null ? (
                    renderNode(cell)
                  ) : typeof cell === "string" ? (
                    <TextCell
                      value={cell}
                      expandLongText={layout.expandLongText === true}
                    />
                  ) : (
                    String(cell ?? "")
                  );
                return (
                  <TableCell className={className} key={column.key}>
                    {content}
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
      </TableBody>
    </>
  );

  return (
    <div className="openlia-openui-table">
      {horizontalScroll ? (
        <ScrollableTable
          aria-label="OpenUI data table"
          className="openlia-openui-table__table openlia-openui-table__table--scroll"
          style={{ minWidth: `${columnDefinitions.length * 8}rem` }}
        >
          {tableContents}
        </ScrollableTable>
      ) : (
        <BasicTable
          aria-label="OpenUI data table"
          className="openlia-openui-table__table"
          containerClassName="openlia-openui-table__container--no-scroll"
        >
          {tableContents}
        </BasicTable>
      )}
      {(canToggleAll || canPaginate) && (
        <nav
          aria-label="Table pagination"
          className="openlia-openui-table__controls"
        >
          <span aria-live="polite" className="openlia-openui-table__status">
            {rowCount === 0
              ? "No rows"
              : `Showing ${startRow + 1}–${endRow} of ${rowCount} rows`}
          </span>
          {canToggleAll && (
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => {
                setShowAll((current) => !current);
                setCurrentPage(0);
              }}
              type="button"
            >
              {showAllRows ? "Show paginated rows" : "Show all rows"}
            </button>
          )}
          {canPaginate && (
            <>
              <button
                aria-label="Previous page"
                className="btn btn-ghost btn-xs"
                disabled={safePage === 0}
                onClick={() => setCurrentPage(Math.max(0, safePage - 1))}
                type="button"
              >
                Previous
              </button>
              <span aria-live="polite" className="openlia-openui-table__page">
                Page {safePage + 1} of {totalPages}
              </span>
              <button
                aria-label="Next page"
                className="btn btn-ghost btn-xs"
                disabled={safePage >= totalPages - 1}
                onClick={() =>
                  setCurrentPage(Math.min(totalPages - 1, safePage + 1))
                }
                type="button"
              >
                Next
              </button>
            </>
          )}
        </nav>
      )}
    </div>
  );
}

export const OpenLiaTable = defineComponent({
  name: "Table",
  description:
    "Responsive data table with configurable pagination, wrapping, expandable text, and literal row-table shorthand",
  props: tableProps,
  component: (args) => <TableView {...args} />,
});
