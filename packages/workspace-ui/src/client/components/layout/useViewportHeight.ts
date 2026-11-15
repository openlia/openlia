import { useEffect, useState } from "react";

/** dvh alone does not account for the on-screen keyboard in every browser. */
export function useViewportHeight() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !element) return;
    let frame = 0;
    const update = () => {
      element.style.setProperty(
        "--workspace-viewport-height",
        `${viewport.height}px`,
      );
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const focused = document.activeElement;
        if (
          focused instanceof HTMLElement &&
          element.contains(focused) &&
          focused.matches("input, textarea")
        ) {
          focused.scrollIntoView({ block: "nearest" });
        }
      });
    };
    update();
    viewport.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", update);
      element.style.removeProperty("--workspace-viewport-height");
    };
  }, [element]);
  return setElement;
}
