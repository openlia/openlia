import { useEffect, useRef, useState, useId, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Portaled so workspace scroll containers cannot clip action menus. */
export function ActionMenu({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({
    top: 0,
    right: 0,
    maxHeight: 400,
  });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLFieldSetElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) {
      const below = window.innerHeight - rect.bottom - 12;
      const above = Math.max(0, rect.top - 12);
      const upwards = below < 240 && above > below;
      const height = Math.min(400, upwards ? above : below);
      setPosition({
        top: upwards ? Math.max(8, rect.top - height - 4) : rect.bottom + 4,
        right: Math.max(8, window.innerWidth - rect.right),
        maxHeight: Math.max(0, height),
      });
    }
    const first = [
      ...(panel.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled):not(.sr-only), a[href]",
      ) ?? []),
    ].find((item) => item.getClientRects().length > 0);
    first?.focus();
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const focusout = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setOpen(false);
    };
    const resize = () => setOpen(false);
    const scroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keydown);
    document.addEventListener("focusin", focusout);
    window.addEventListener("resize", resize);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", focusout);
      window.removeEventListener("resize", resize);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`btn btn-ghost btn-square ${className}`}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        •••
      </button>
      {open &&
        createPortal(
          <fieldset
            ref={panel}
            id={id}
            aria-label={label}
            className="workspace-action-menu"
            style={position}
            onKeyDown={(event) => {
              const items = [
                ...(panel.current?.querySelectorAll<HTMLElement>(
                  "button:not(:disabled):not(.sr-only), a[href]",
                ) ?? []),
              ].filter((item) => item.getClientRects().length > 0);
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const index = items.indexOf(
                  document.activeElement as HTMLElement,
                );
                items[
                  (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    items.length) %
                    items.length
                ]?.focus();
              }
            }}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("button, a")) {
                setOpen(false);
                trigger.current?.focus();
              }
            }}
          >
            <button
              className="sr-only focus:not-sr-only"
              type="button"
              onClick={() => setOpen(false)}
            >
              Close {label}
            </button>
            {children}
          </fieldset>,
          document.body,
        )}
    </>
  );
}
