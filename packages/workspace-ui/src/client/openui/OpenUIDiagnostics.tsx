import { createParser } from "@openuidev/react-lang";
import { useMemo } from "react";
import { normalizeOpenUIProgram, openliaLibrary } from "./library";

const parser = createParser(openliaLibrary.toJSONSchema());

export function OpenUIDiagnostics({ content }: { content: string }) {
  const errors = useMemo(() => {
    const result = parser.parse(normalizeOpenUIProgram(content));
    return [
      ...result.meta.errors.map((error) => `${error.code}: ${error.message}`),
      ...(!result.root ? ["Missing required root statement"] : []),
    ];
  }, [content]);
  return (
    <section
      aria-label="OpenUI diagnostics"
      role="status"
      className={`shrink-0 px-3 py-2 text-xs ${errors.length ? "bg-warning/10 text-warning" : "text-success"}`}
    >
      <p className="font-semibold">
        {errors.length
          ? "OpenUI layout diagnostics"
          : "OpenUI layout is valid."}
      </p>
      {errors.length > 0 && (
        <ul className="max-h-24 overflow-auto">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
