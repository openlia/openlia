import type React from "react";
import { useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../../openliaLinks";

export function CopyLinkButton({
  link,
  label = "Copy Link",
  copiedLabel = "Copied!",
  className = "btn btn-outline btn-sm gap-1.5",
  title = "Copy link to clipboard",
  iconOnly = false,
  size = "sm",
  onClick,
}: {
  link: string;
  label?: string | undefined;
  copiedLabel?: string | undefined;
  className?: string | undefined;
  title?: string | undefined;
  iconOnly?: boolean | undefined;
  size?: "xs" | "sm" | undefined;
  onClick?: (() => void) | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyToClipboard(link);
    if (ok) {
      setCopied(true);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        setCopied(false);
      }, 2000);
    }
    onClick?.();
  };

  return (
    <button
      aria-label={copied ? "Link copied to clipboard" : title}
      className={`${className} ${size === "xs" ? "btn-xs" : ""}`}
      onClick={handleCopy}
      title={copied ? "Copied!" : title}
      type="button"
    >
      {copied ? (
        <svg
          className={
            size === "xs" ? "h-3 w-3 text-success" : "h-3.5 w-3.5 text-success"
          }
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <title>Checkmark icon</title>
          <path
            d="M5 13l4 4L19 7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg
          className={
            size === "xs" ? "h-3 w-3 opacity-70" : "h-3.5 w-3.5 opacity-70"
          }
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <title>Copy link icon</title>
          <path
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {!iconOnly && <span>{copied ? copiedLabel : label}</span>}
    </button>
  );
}
