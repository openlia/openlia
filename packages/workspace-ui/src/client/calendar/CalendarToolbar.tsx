import { useState } from "react";
import type { CalendarFilterState, CalendarViewMode } from "./types";

export interface CalendarToolbarProps {
  viewMode: CalendarViewMode;
  onViewModeChange: (mode: CalendarViewMode) => void;
  title: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onNewEvent: () => void;
  onSwitchToEdit?: (() => void) | undefined;
  availableTags?: string[];
  availablePeople?: string[];
  filterState?: CalendarFilterState;
  onFilterChange?: (next: CalendarFilterState) => void;
}

export function CalendarToolbar({
  viewMode,
  onViewModeChange,
  title,
  onPrev,
  onNext,
  onToday,
  onNewEvent,
  onSwitchToEdit,
  availableTags = [],
  availablePeople = [],
  filterState,
  onFilterChange,
}: CalendarToolbarProps) {
  const [showFilters, setShowFilters] = useState(false);

  const selectedTags = filterState?.selectedTags ?? new Set<string>();
  const selectedPeople = filterState?.selectedPeople ?? new Set<string>();
  const searchQuery = filterState?.searchQuery ?? "";

  const activeFilterCount =
    selectedTags.size + selectedPeople.size + (searchQuery.trim() ? 1 : 0);

  const handleToggleTag = (tag: string) => {
    if (!onFilterChange || !filterState) return;
    const next = new Set(selectedTags);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    onFilterChange({ ...filterState, selectedTags: next });
  };

  const handleTogglePerson = (person: string) => {
    if (!onFilterChange || !filterState) return;
    const next = new Set(selectedPeople);
    if (next.has(person)) next.delete(person);
    else next.add(person);
    onFilterChange({ ...filterState, selectedPeople: next });
  };

  const handleSearchChange = (query: string) => {
    if (!onFilterChange || !filterState) return;
    onFilterChange({ ...filterState, searchQuery: query });
  };

  const handleClearFilters = () => {
    if (!onFilterChange || !filterState) return;
    onFilterChange({
      ...filterState,
      selectedTags: new Set(),
      selectedPeople: new Set(),
      searchQuery: "",
    });
  };

  return (
    <div className="flex flex-col border-b border-base-content/10 bg-base-200/50">
      {/* Top main toolbar row */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-1.5 sm:gap-2 sm:px-4 sm:py-2 text-sm">
        {/* Left: View Mode Switcher & Navigation */}
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <div className="join border border-base-content/15 rounded-lg bg-base-100 p-0.5 shadow-xs">
            <button
              type="button"
              className={`btn btn-xs join-item ${viewMode === "month" ? "btn-primary shadow-xs" : "btn-ghost"}`}
              onClick={() => onViewModeChange("month")}
              aria-pressed={viewMode === "month"}
            >
              Month
            </button>
            <button
              type="button"
              className={`btn btn-xs join-item ${viewMode === "week" ? "btn-primary shadow-xs" : "btn-ghost"}`}
              onClick={() => onViewModeChange("week")}
              aria-pressed={viewMode === "week"}
            >
              Week
            </button>
            <button
              type="button"
              className={`btn btn-xs join-item ${viewMode === "gantt" ? "btn-primary shadow-xs" : "btn-ghost"}`}
              onClick={() => onViewModeChange("gantt")}
              aria-pressed={viewMode === "gantt"}
            >
              Gantt
            </button>
          </div>

          {/* Date Navigation */}
          <div className="join border border-base-content/15 rounded-lg bg-base-100 p-0.5 shadow-xs">
            <button
              type="button"
              className="btn btn-xs btn-ghost join-item"
              onClick={onPrev}
              aria-label="Previous period"
              title="Previous"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <button
              type="button"
              className="btn btn-xs btn-ghost join-item px-2 font-medium"
              onClick={onToday}
              title="Jump to today"
            >
              Today
            </button>
            <button
              type="button"
              className="btn btn-xs btn-ghost join-item"
              onClick={onNext}
              aria-label="Next period"
              title="Next"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </button>
          </div>

          <h2 className="text-base font-semibold tracking-tight text-base-content ml-1">
            {title}
          </h2>
        </div>

        {/* Right: Filter toggle, New Event and Raw Remind shortcut */}
        <div className="flex items-center gap-2">
          {/* Filter toggle button */}
          {(availableTags.length > 0 || availablePeople.length > 0) && (
            <button
              type="button"
              className={`btn btn-xs gap-1 border border-base-content/15 ${
                showFilters || activeFilterCount > 0
                  ? "btn-secondary text-secondary-content"
                  : "btn-ghost"
              }`}
              onClick={() => setShowFilters((prev) => !prev)}
              title="Filter by tags, people, and keywords"
              aria-label="Filter events"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                />
              </svg>
              <span>Filter</span>
              {activeFilterCount > 0 && (
                <span className="badge badge-xs badge-neutral ml-0.5">
                  {activeFilterCount}
                </span>
              )}
            </button>
          )}

          {/* New Event Button */}
          <button
            type="button"
            className="btn btn-xs btn-primary gap-1 shadow-xs"
            onClick={onNewEvent}
            title="Add a new event"
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            <span>New Event</span>
          </button>

          {/* Raw Remind shortcut */}
          {onSwitchToEdit && (
            <button
              type="button"
              className="btn btn-xs btn-ghost text-base-content/60 hover:text-base-content"
              onClick={onSwitchToEdit}
              title="Edit raw Remind syntax in CodeMirror"
            >
              Edit Source
            </button>
          )}
        </div>
      </div>

      {/* Expandable Filter Bar */}
      {(showFilters || activeFilterCount > 0) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-base-content/10 bg-base-100 px-4 py-2 text-xs">
          {/* Search Query Input */}
          <div className="flex items-center gap-1 rounded-md border border-base-content/20 bg-base-200/50 px-2 py-0.5">
            <svg
              className="h-3.5 w-3.5 opacity-50 shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              type="text"
              placeholder="Search events..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-36 bg-transparent text-xs outline-hidden placeholder:text-base-content/40"
              aria-label="Search calendar events"
            />
            {searchQuery && (
              <button
                type="button"
                className="btn btn-ghost btn-xs h-3.5 w-3.5 min-h-0 p-0 text-base-content/50 hover:text-base-content"
                onClick={() => handleSearchChange("")}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          {/* Tags Chips */}
          {availableTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="font-semibold text-base-content/50 uppercase text-[10px] tracking-wide">
                Tags:
              </span>
              {availableTags.map((tag) => {
                const isSelected = selectedTags.has(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    className={`badge badge-sm cursor-pointer transition-colors ${
                      isSelected
                        ? "badge-primary font-semibold"
                        : "badge-ghost opacity-75 hover:opacity-100"
                    }`}
                    onClick={() => handleToggleTag(tag)}
                  >
                    #{tag}
                  </button>
                );
              })}
            </div>
          )}

          {/* People / Attendees Chips */}
          {availablePeople.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="font-semibold text-base-content/50 uppercase text-[10px] tracking-wide">
                People:
              </span>
              {availablePeople.map((person) => {
                const isSelected = selectedPeople.has(person);
                return (
                  <button
                    key={person}
                    type="button"
                    className={`badge badge-sm cursor-pointer transition-colors ${
                      isSelected
                        ? "badge-secondary font-semibold"
                        : "badge-ghost opacity-75 hover:opacity-100"
                    }`}
                    onClick={() => handleTogglePerson(person)}
                  >
                    👤 {person}
                  </button>
                );
              })}
            </div>
          )}

          {/* Reset Filters button */}
          {activeFilterCount > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-xs text-error font-medium ml-auto"
              onClick={handleClearFilters}
            >
              Reset filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
