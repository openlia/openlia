import { useId, useMemo, useState } from "react";
import type { SkillSummary } from "../shared/api";

type SkillFilterStatus = "all" | "enabled" | "disabled" | "pinned";

export interface SkillsNavigatorProps {
  skills: SkillSummary[];
  categories: string[];
  selectedSkillId: string | null;
  onSelectSkill: (id: string) => void;
  filter: string;
  onFilterChange: (filter: string) => void;
  onCreateClick: () => void;
  onTogglePin?: (id: string, pinned: boolean) => void;
  loading?: boolean;
}

export function SkillsNavigator({
  skills,
  categories: _categories,
  selectedSkillId,
  onSelectSkill,
  filter,
  onFilterChange,
  onCreateClick,
  onTogglePin,
  loading = false,
}: SkillsNavigatorProps) {
  const searchId = useId();
  const [statusFilter, setStatusFilter] = useState<SkillFilterStatus>("all");
  const [collapsedCategories, setCollapsedCategories] = useState<
    Record<string, boolean>
  >({});

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => ({
      ...prev,
      [cat]: !prev[cat],
    }));
  };

  const filteredSkills = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return skills.filter((skill) => {
      // Status filter
      if (statusFilter === "enabled" && !skill.enabled) return false;
      if (statusFilter === "disabled" && skill.enabled) return false;
      if (statusFilter === "pinned" && !skill.pinned) return false;

      // Text query filter
      if (!query) return true;
      return (
        skill.name.toLowerCase().includes(query) ||
        skill.id.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query) ||
        skill.category.toLowerCase().includes(query) ||
        skill.tags.some((t) => t.toLowerCase().includes(query))
      );
    });
  }, [skills, filter, statusFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, SkillSummary[]>();
    for (const skill of filteredSkills) {
      const cat = skill.category || "standalone";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)?.push(skill);
    }
    return map;
  }, [filteredSkills]);

  return (
    <aside
      aria-label="Skills navigator"
      className="workspace-navigator flex h-full w-full overflow-hidden"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-base-content/10 p-3">
        <h2 className="text-sm font-semibold tracking-wide uppercase text-base-content/70">
          Skills ({skills.length})
        </h2>
        <button
          className="btn btn-primary btn-xs gap-1"
          onClick={onCreateClick}
          type="button"
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <title>New Skill</title>
            <path
              d="M12 4v16m8-8H4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          New Skill
        </button>
      </div>

      <div className="shrink-0 border-b border-base-content/10 p-2">
        <label className="sr-only" htmlFor={searchId}>
          Search skills
        </label>
        <div className="relative">
          <input
            className="input input-bordered input-sm w-full pl-8 text-sm"
            id={searchId}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Search skills, tags..."
            type="search"
            value={filter}
          />
          <svg
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-base-content/40"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <title>Search</title>
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </div>

        <div className="mt-2 flex gap-1 text-xs">
          {(["all", "enabled", "disabled", "pinned"] as const).map((status) => (
            <button
              key={status}
              className={`btn btn-xs rounded-full capitalize ${
                statusFilter === status
                  ? "btn-neutral"
                  : "btn-ghost text-base-content/60"
              }`}
              onClick={() => setStatusFilter(status)}
              type="button"
            >
              {status}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center justify-center p-8 text-sm text-base-content/50">
            Loading skills...
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="p-6 text-center text-sm text-base-content/50">
            No skills match your filter.
          </div>
        ) : (
          Array.from(grouped.entries()).map(([cat, catSkills]) => {
            const isCollapsed = Boolean(collapsedCategories[cat]);
            return (
              <div key={cat} className="mb-2">
                <button
                  className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs font-semibold tracking-wider uppercase text-base-content/60 hover:bg-base-200"
                  onClick={() => toggleCategory(cat)}
                  type="button"
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <svg
                      className={`h-3 w-3 shrink-0 transition-transform ${
                        isCollapsed ? "-rotate-90" : ""
                      }`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      viewBox="0 0 24 24"
                    >
                      <title>Toggle Category</title>
                      <path
                        d="m19 9-7 7-7-7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {cat}
                  </span>
                  <span className="badge badge-ghost badge-xs">
                    {catSkills.length}
                  </span>
                </button>

                {!isCollapsed && (
                  <ul className="mt-1 space-y-0.5 pl-2">
                    {catSkills.map((skill) => {
                      const isSelected = selectedSkillId === skill.id;
                      return (
                        <li key={skill.id} className="relative group">
                          <button
                            className={`flex w-full cursor-pointer items-start gap-2 rounded-md p-2 text-left text-sm transition-colors pr-8 ${
                              isSelected
                                ? "bg-primary text-primary-content"
                                : "hover:bg-base-200 text-base-content"
                            }`}
                            onClick={() => onSelectSkill(skill.id)}
                            type="button"
                          >
                            <span
                              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                                skill.enabled
                                  ? isSelected
                                    ? "bg-white"
                                    : "bg-success"
                                  : "bg-base-content/30"
                              }`}
                              title={skill.enabled ? "Enabled" : "Disabled"}
                            />

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-1">
                                <span className="truncate font-medium">
                                  {skill.name}
                                </span>
                                {skill.version && (
                                  <span
                                    className={`text-[10px] opacity-75 ${
                                      isSelected ? "text-primary-content" : ""
                                    }`}
                                  >
                                    v{skill.version}
                                  </span>
                                )}
                              </div>

                              {skill.description && (
                                <p
                                  className={`line-clamp-2 text-xs ${
                                    isSelected
                                      ? "text-primary-content/80"
                                      : "text-base-content/60"
                                  }`}
                                >
                                  {skill.description}
                                </p>
                              )}

                              {skill.tags.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {skill.tags.slice(0, 3).map((tag) => (
                                    <span
                                      key={tag}
                                      className={`badge badge-xs text-[9px] ${
                                        isSelected
                                          ? "badge-neutral"
                                          : "badge-ghost opacity-70"
                                      }`}
                                    >
                                      {tag}
                                    </span>
                                  ))}
                                  {skill.tags.length > 3 && (
                                    <span className="text-[9px] opacity-50">
                                      +{skill.tags.length - 3}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </button>

                          {onTogglePin && (
                            <button
                              aria-label={
                                skill.pinned ? "Unpin skill" : "Pin skill"
                              }
                              className={`absolute top-2 right-2 btn btn-ghost btn-circle btn-xs h-5 w-5 min-h-0 ${
                                skill.pinned
                                  ? "text-warning opacity-100"
                                  : "opacity-0 group-hover:opacity-60"
                              }`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onTogglePin(skill.id, !skill.pinned);
                              }}
                              type="button"
                            >
                              <svg
                                className="h-3 w-3 fill-current"
                                viewBox="0 0 24 24"
                              >
                                <title>{skill.pinned ? "Pinned" : "Pin"}</title>
                                <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
                              </svg>
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
