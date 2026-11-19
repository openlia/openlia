import type { ReactNode } from "react";
import type { DocumentScope } from "../../../shared/api";

export interface ScopeSwitcherProps {
  activeScope: DocumentScope;
  onScopeChange: (scope: DocumentScope) => void;
  workspaceCount?: number | undefined;
  skillsCount?: number | undefined;
  agentCount?: number | undefined;
  size?: "sm" | "xs" | undefined;
  className?: string | undefined;
}

export function ScopeSwitcher({
  activeScope,
  onScopeChange,
  workspaceCount,
  skillsCount,
  agentCount,
  size = "xs",
  className = "",
}: ScopeSwitcherProps) {
  const btnSize = size === "sm" ? "btn-sm" : "btn-xs";

  const scopes: {
    id: DocumentScope;
    label: string;
    count?: number | undefined;
    icon: ReactNode;
  }[] = [
    {
      id: "workspace",
      label: "Workspace",
      count: workspaceCount,
      icon: (
        <svg
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 opacity-80"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path
            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      id: "skills",
      label: "Skills",
      count: skillsCount,
      icon: (
        <svg
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 opacity-80"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path
            d="M13 10V3L4 14h7v7l9-11h-7z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      id: "agent",
      label: "Agent",
      count: agentCount,
      icon: (
        <svg
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 opacity-80"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path
            d="M12 2v2m-6 4a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2v-8a2 2 0 00-2-2H6zm0 0V6a2 2 0 012-2h8a2 2 0 012 2v2M9 13h.01M15 13h.01M9 17h6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
  ];

  return (
    <nav
      aria-label="Scope switcher"
      className={`join bg-base-200/80 p-0.5 rounded-lg border border-base-content/10 ${className}`}
    >
      {scopes.map((item) => {
        const isActive = activeScope === item.id;
        return (
          <button
            key={item.id}
            aria-current={isActive ? "page" : undefined}
            aria-label={`${item.label} scope`}
            data-testid={`scope-tab-${item.id}`}
            className={`join-item btn ${btnSize} gap-1.5 transition-all font-medium ${
              isActive
                ? "btn-neutral text-base-content shadow-xs"
                : "btn-ghost text-base-content/70 hover:text-base-content"
            }`}
            onClick={() => onScopeChange(item.id)}
            type="button"
          >
            {item.icon}
            <span className="truncate">{item.label}</span>
            {typeof item.count === "number" && (
              <span
                className={`badge badge-xs text-[10px] px-1.5 py-0.5 leading-none shrink-0 ${
                  isActive
                    ? "bg-base-100 text-base-content"
                    : "bg-base-300 text-base-content/70"
                }`}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
