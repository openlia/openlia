import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** One navigator shared by the desktop sidebar and the modal mobile drawer. */
export function ResponsiveDrawer({
  children,
  open,
  onClose,
  title,
  className = "",
  label = title,
  desktopQuery = "(min-width: 1280px)",
}: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  title: string;
  className?: string;
  label?: string;
  desktopQuery?: string;
}) {
  // Match the server render; update after hydration so desktop sidebars do not
  // retain the mobile inert attribute from the server HTML.
  const [desktop, setDesktop] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();
  useEffect(() => {
    const query = window.matchMedia(desktopQuery);
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [desktopQuery]);
  useEffect(() => {
    if (!open || desktop || !panel.current) return;
    const element = panel.current;
    const previous = document.activeElement;
    const inertElements: { element: HTMLElement; inert: boolean }[] = [];
    let branch: HTMLElement = element;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          inertElements.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element
      .querySelector<HTMLButtonElement>('button:not([tabindex="-1"])')
      ?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key !== "Tab") return;
      const targets = [
        ...element.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ].filter(
        (target) =>
          target.tabIndex !== -1 && target.getClientRects().length > 0,
      );
      const first = targets[0];
      const last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    element.addEventListener("keydown", keydown);
    return () => {
      element.removeEventListener("keydown", keydown);
      for (const item of inertElements) item.element.inert = item.inert;
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [open, desktop]);
  return (
    <aside
      ref={panel}
      className={`responsive-drawer ${open ? "is-open" : ""} ${className}`}
      inert={!desktop && !open}
      role={!desktop && open ? "dialog" : "complementary"}
      {...(!desktop && open ? { "aria-modal": true } : {})}
      aria-label={label}
    >
      <button
        type="button"
        className="responsive-drawer-backdrop"
        aria-label={`Dismiss ${title}`}
        tabIndex={-1}
        onClick={onClose}
      />
      <div className="responsive-drawer-surface">
        <div className="responsive-drawer-heading">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="btn btn-ghost btn-square"
            aria-label={`Close ${title}`}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </aside>
  );
}
