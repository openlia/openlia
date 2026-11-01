import { useEffect, useId, useState, type ReactNode } from "react";

/** Keep wide controls inside their own scrollport, not the page's overflow. */
export function ScrollableToolbar({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const hintId = useId();
  useEffect(() => {
    if (!viewport) return;
    const update = () =>
      setOverflowing(viewport.scrollWidth > viewport.clientWidth + 1);
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    if (viewport.firstElementChild)
      observer.observe(viewport.firstElementChild);
    update();
    return () => observer.disconnect();
  }, [viewport]);
  return (
    <div className="workspace-scrollable-toolbar">
      <div
        ref={setViewport}
        className="workspace-toolbar-scrollport"
        role="toolbar"
        aria-label={label}
        aria-orientation="horizontal"
        aria-describedby={overflowing ? hintId : undefined}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) {
            const buttons = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            ];
            const current = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (current < 0) return;
            let next = current;
            if (event.key === "ArrowRight")
              next = Math.min(current + 1, buttons.length - 1);
            else if (event.key === "ArrowLeft") next = Math.max(current - 1, 0);
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = buttons.length - 1;
            else return;
            event.preventDefault();
            buttons[next]?.focus();
            buttons[next]?.scrollIntoView({
              block: "nearest",
              inline: "nearest",
            });
          }
        }}
      >
        <div className="workspace-toolbar-items">{children}</div>
      </div>
      {overflowing && (
        <p id={hintId} className="mt-1 text-xs text-base-content/60">
          <span aria-hidden="true">↔ </span>
          <span>Scroll for more modes</span>
        </p>
      )}
    </div>
  );
}
