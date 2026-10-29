import { createParser } from "@openuidev/react-lang";
import { useMemo } from "react";
import { normalizeOpenUIProgram, openliaLibrary } from "./library";

const parser = createParser(openliaLibrary.toJSONSchema());

export function OpenUIDiagnostics({
  content,
  variant = "default",
}: {
  content: string;
  variant?: "default" | "toolbar" | "errors-only";
}) {
  const errors = useMemo(() => {
    const result = parser.parse(normalizeOpenUIProgram(content));
    return [
      ...result.meta.errors.map((error) => `${error.code}: ${error.message}`),
      ...(!result.root ? ["Missing required root statement"] : []),
    ];
  }, [content]);
  if (
    (variant === "toolbar" && errors.length > 0) ||
    (variant === "errors-only" && errors.length === 0)
  ) {
    return null;
  }

  return (
    <section
      aria-label="OpenUI diagnostics"
      role="status"
      className={`shrink-0 text-xs ${variant === "toolbar" ? "text-success/80" : `px-3 py-2 ${errors.length ? "bg-warning/10 text-warning" : "text-success"}`}`}
    >
      <p className={variant === "toolbar" ? "font-medium" : "font-semibold"}>
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
