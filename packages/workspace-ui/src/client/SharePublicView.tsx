import { useEffect, useState, type ComponentProps } from "react";
import type { PublicShareResponse } from "../shared/api";
import { ApiError, httpWorkspaceApi, type WorkspaceApi } from "./api";
import { isMarkdownPath } from "./CodeEditor";
import { MarkdownPreview as WorkspaceMarkdownPreview } from "./components/editor/MarkdownPreview";
import { OpenLiaOpenUIProvider } from "./openui/context";
import { copyToClipboard } from "./openliaLinks";
import {
  formatByteSize,
  formatExpirationSummary,
  formatShareTimestamp,
} from "./ShareModal";

export interface SharePublicViewProps {
  shareId: string;
  api?: WorkspaceApi | undefined;
}

// Public snapshots must not inherit authenticated workspace capabilities.
function MarkdownPreview(
  props: ComponentProps<typeof WorkspaceMarkdownPreview>,
) {
  return (
    <OpenLiaOpenUIProvider value={{}}>
      <WorkspaceMarkdownPreview {...props} />
    </OpenLiaOpenUIProvider>
  );
}

type SkillSubTab = "instructions" | "files" | "overview";

function fileExtension(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  return lastDot > lastSlash ? path.slice(lastDot).toLowerCase() : "";
}

function classifyBinaryPreviewKind(
  path: string,
  mediaType: string,
): "image" | "pdf" | "audio" | "video" | "other" {
  const ext = fileExtension(path);
  const lowerMedia = mediaType.toLowerCase();
  if (
    lowerMedia.startsWith("image/") ||
    [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".webp",
      ".svg",
      ".avif",
      ".bmp",
    ].includes(ext)
  ) {
    return "image";
  }
  if (lowerMedia === "application/pdf" || ext === ".pdf") {
    return "pdf";
  }
  if (
    lowerMedia.startsWith("audio/") ||
    [".mp3", ".wav", ".ogg", ".oga", ".m4a", ".flac"].includes(ext)
  ) {
    return "audio";
  }
  if (
    lowerMedia.startsWith("video/") ||
    [".mp4", ".webm", ".mov", ".ogv"].includes(ext)
  ) {
    return "video";
  }
  return "other";
}

export function SharePublicView({
  shareId,
  api = httpWorkspaceApi,
}: SharePublicViewProps) {
  const [data, setData] = useState<PublicShareResponse["share"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState<{
    status: number;
    code: string;
  } | null>(null);
  const [docViewMode, setDocViewMode] = useState<"preview" | "raw">("preview");
  const [skillTab, setSkillTab] = useState<SkillSubTab>("instructions");
  const [skillDocMode, setSkillDocMode] = useState<"preview" | "source">(
    "preview",
  );
  const [selectedSkillFile, setSelectedSkillFile] =
    useState<string>("SKILL.md");
  const [copiedText, setCopiedText] = useState(false);

  // Ensure <meta name="robots" content="noindex, nofollow, noarchive" /> is present in <head>
  useEffect(() => {
    if (typeof document === "undefined") return;
    let meta = document.head.querySelector(
      'meta[name="robots"]',
    ) as HTMLMetaElement | null;
    const created = !meta;
    const previousContent = meta?.getAttribute("content") ?? null;
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "robots");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", "noindex, nofollow, noarchive");

    return () => {
      if (created && meta?.parentNode) {
        meta.parentNode.removeChild(meta);
      } else if (meta && previousContent !== null) {
        meta.setAttribute("content", previousContent);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorState(null);

    api
      .getPublicShare(shareId)
      .then((res) => {
        if (cancelled) return;
        setData(res.share);
        setDocViewMode("preview");
        setSkillTab("instructions");
        const defaultFile =
          res.share.files.find((f) => f.path === "SKILL.md")?.path ??
          res.share.files[0]?.path ??
          "SKILL.md";
        setSelectedSkillFile(defaultFile);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setErrorState({
            status: err.status,
            code: err.payload?.error ?? "share_not_found",
          });
        } else {
          setErrorState({ status: 404, code: "share_not_found" });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, shareId]);

  async function handleCopyText(text: string) {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 2000);
    }
  }

  if (loading) {
    return (
      <main
        aria-label="Public Share View"
        className="grid min-h-dvh place-items-center bg-base-300 p-6 text-base-content"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="loading loading-spinner loading-md text-primary" />
          <p className="text-sm text-base-content/65">
            Loading shared snapshot...
          </p>
        </div>
      </main>
    );
  }

  if (errorState || !data) {
    const isRateLimited = errorState?.status === 429;
    return (
      <main
        aria-label="Public Share View"
        className="grid min-h-dvh place-items-center bg-base-300 p-6 text-base-content"
      >
        <div className="w-full max-w-md rounded-2xl border border-base-300 bg-base-100 p-8 text-center shadow-xl">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-error/15 text-error font-bold text-lg">
            !
          </div>
          <p className="text-[11px] font-bold uppercase tracking-widest text-base-content/50">
            OPENLIA / PUBLIC SHARE
          </p>
          <h1 className="mt-1 text-xl font-bold text-base-content">
            {isRateLimited
              ? "Too Many Requests"
              : "Share Link Not Found or Expired"}
          </h1>
          <p className="mt-2 text-xs leading-relaxed text-base-content/65">
            {isRateLimited
              ? "Too many invalid share lookups were attempted from your network. Please wait a few minutes and try again."
              : "This shared snapshot link may have expired, been revoked by its owner, or never existed. Expired snapshots are permanently removed."}
          </p>
        </div>
      </main>
    );
  }

  if (data.kind === "workspace") {
    const isMarkdown = isMarkdownPath(data.target_path);
    const hasRichPreview = data.editable && isMarkdown;
    const primaryContent = data.content ?? "";
    const rawUrl = api.publicShareRawUrl(data.id, data.target_path);
    const downloadUrl = api.publicShareDownloadUrl(data.id, data.target_path);
    const binaryKind = !data.editable
      ? classifyBinaryPreviewKind(data.target_path, data.media_type)
      : "other";

    return (
      <section
        aria-label="Public Share View"
        className="flex min-h-dvh flex-col bg-base-300 text-base-content"
      >
        <header className="border-b border-base-300 bg-base-100 px-3.5 py-2.5 shadow-xs sm:px-6 sm:py-4">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 sm:gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-primary sm:text-[11px]">
                  OPENLIA / SHARED DOCUMENT
                </span>
                <span
                  className="badge badge-ghost badge-xs max-w-[200px] font-mono sm:max-w-none"
                  title={data.target_path}
                >
                  <span className="truncate">{data.target_path}</span>
                </span>
                <span className="badge badge-outline badge-xs hidden sm:inline-flex">
                  {formatExpirationSummary(data.expires_at)}
                </span>
              </div>
              <h1 className="mt-0.5 truncate text-base font-bold text-base-content sm:mt-1 sm:text-xl">
                {data.title}
              </h1>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-base-content/60 sm:gap-x-3 sm:text-xs">
                <span>Snapshotted {formatShareTimestamp(data.updated_at)}</span>
                <span>·</span>
                <span>{formatByteSize(data.total_bytes)}</span>
                <span className="sm:hidden">·</span>
                <span className="sm:hidden">
                  {formatExpirationSummary(data.expires_at)}
                </span>
                {data.file_count > 1 && (
                  <>
                    <span>·</span>
                    <span>
                      Includes {data.file_count - 1} referenced{" "}
                      {data.file_count - 1 === 1 ? "file" : "files"}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex w-full flex-wrap items-center justify-between gap-1.5 sm:w-auto sm:justify-end sm:gap-2">
              {hasRichPreview && (
                <fieldset
                  aria-label="View mode"
                  className="join border border-base-300 rounded-lg"
                >
                  <button
                    type="button"
                    className={`btn btn-xs join-item px-2 sm:px-3 ${
                      docViewMode === "preview" ? "btn-primary" : "btn-ghost"
                    }`}
                    onClick={() => setDocViewMode("preview")}
                  >
                    <span className="hidden sm:inline">Rendered </span>
                    Preview
                  </button>
                  <button
                    type="button"
                    className={`btn btn-xs join-item px-2 sm:px-3 ${
                      docViewMode === "raw" ? "btn-primary" : "btn-ghost"
                    }`}
                    onClick={() => setDocViewMode("raw")}
                  >
                    Raw<span className="hidden sm:inline"> Source</span>
                  </button>
                </fieldset>
              )}

              <div className="flex items-center gap-1.5 sm:gap-2">
                {data.editable && (
                  <button
                    type="button"
                    className="btn btn-outline btn-xs sm:btn-sm"
                    onClick={() => void handleCopyText(primaryContent)}
                  >
                    {copiedText ? (
                      "Copied!"
                    ) : (
                      <>
                        Copy<span className="hidden sm:inline"> Content</span>
                      </>
                    )}
                  </button>
                )}

                <a
                  href={downloadUrl}
                  download
                  className="btn btn-primary btn-xs sm:btn-sm"
                >
                  Download<span className="hidden sm:inline"> File</span>
                </a>
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col p-0 sm:p-6">
          <div className="flex-1 overflow-hidden border-b border-base-300 bg-base-100 sm:rounded-xl sm:border sm:shadow-sm">
            {data.editable ? (
              docViewMode === "preview" && isMarkdown ? (
                <MarkdownPreview
                  content={primaryContent}
                  currentFilePath={data.target_path}
                />
              ) : (
                <pre className="overflow-x-auto p-3.5 font-mono text-xs leading-relaxed text-base-content sm:p-6">
                  <code>{primaryContent}</code>
                </pre>
              )
            ) : (
              <div className="flex flex-col items-center justify-center gap-4 p-4 sm:p-8">
                {binaryKind === "image" && (
                  <img
                    src={rawUrl}
                    alt={data.title}
                    className="max-h-[70vh] rounded-lg border border-base-300 object-contain"
                  />
                )}
                {binaryKind === "pdf" && (
                  <iframe
                    src={rawUrl}
                    title={data.title}
                    className="h-[75vh] w-full rounded-lg border border-base-300"
                  />
                )}
                {binaryKind === "audio" && (
                  <audio controls src={rawUrl} className="w-full max-w-lg">
                    <track kind="captions" />
                  </audio>
                )}
                {binaryKind === "video" && (
                  <video
                    controls
                    src={rawUrl}
                    className="max-h-[70vh] w-full max-w-4xl rounded-lg border border-base-300"
                  >
                    <track kind="captions" />
                  </video>
                )}
                {binaryKind === "other" && (
                  <div className="py-12 text-center">
                    <p className="text-sm font-medium text-base-content">
                      Binary Artifact ({data.media_type})
                    </p>
                    <p className="mt-1 text-xs text-base-content/60">
                      {formatByteSize(data.total_bytes)} · Download the file to
                      view it locally.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      </section>
    );
  }

  // Skill package public share view
  const meta = data.skill_metadata;
  const skillMdEntry =
    data.files.find((f) => f.path === "SKILL.md") ?? data.files[0];
  const skillMdContent = skillMdEntry?.content ?? data.content ?? "";
  const activeFileEntry =
    data.files.find((f) => f.path === selectedSkillFile) ??
    skillMdEntry ??
    data.files[0];
  const zipDownloadUrl = api.publicShareSkillDownloadUrl(data.id);

  return (
    <section
      aria-label="Public Share View"
      className="flex min-h-dvh flex-col bg-base-300 text-base-content"
    >
      <header className="border-b border-base-300 bg-base-100 px-3.5 py-2.5 shadow-xs sm:px-6 sm:py-5">
        <div className="mx-auto max-w-6xl space-y-2 sm:space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2 sm:gap-4">
            <div className="min-w-0 space-y-0.5 sm:space-y-1">
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-secondary sm:text-[11px]">
                  OPENLIA / SHARED SKILL PACKAGE
                </span>
                {meta?.category && (
                  <span className="badge badge-secondary badge-outline badge-xs uppercase">
                    {meta.category}
                  </span>
                )}
                {meta?.version && (
                  <span className="badge badge-ghost badge-xs font-mono">
                    v{meta.version}
                  </span>
                )}
                {meta?.license && (
                  <span className="badge badge-ghost badge-xs">
                    {meta.license}
                  </span>
                )}
                <span className="badge badge-outline badge-xs">
                  {formatExpirationSummary(data.expires_at)}
                </span>
              </div>

              <h1 className="text-lg font-bold text-base-content sm:text-2xl">
                {meta?.name || data.title}
              </h1>
              {meta?.description && (
                <p className="max-w-3xl text-xs text-base-content/75 sm:text-sm">
                  {meta.description}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-0.5 text-[11px] text-base-content/60 sm:gap-x-3 sm:pt-1 sm:text-xs">
                <span>Snapshotted {formatShareTimestamp(data.updated_at)}</span>
                <span>·</span>
                <span>
                  {data.file_count} {data.file_count === 1 ? "file" : "files"} (
                  {formatByteSize(data.total_bytes)})
                </span>
                {meta?.author && (
                  <>
                    <span>·</span>
                    <span>Author: {meta.author}</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <a
                href={zipDownloadUrl}
                download
                className="btn btn-primary btn-xs gap-1.5 sm:btn-sm sm:gap-2"
              >
                Download Skill Package (.zip)
              </a>
            </div>
          </div>

          {meta?.tags && meta.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {meta.tags.map((tag) => (
                <span
                  key={tag}
                  className="badge badge-ghost badge-xs font-medium"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}

          <div
            role="tablist"
            aria-label="Skill package sections"
            className="tabs tabs-bordered pt-1 sm:pt-2"
          >
            <button
              type="button"
              role="tab"
              aria-selected={skillTab === "instructions"}
              className={`tab tab-xs sm:tab-sm font-semibold ${
                skillTab === "instructions" ? "tab-active text-primary" : ""
              }`}
              onClick={() => setSkillTab("instructions")}
            >
              Instructions (SKILL.md)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={skillTab === "files"}
              className={`tab tab-xs sm:tab-sm font-semibold ${
                skillTab === "files" ? "tab-active text-primary" : ""
              }`}
              onClick={() => setSkillTab("files")}
            >
              Files ({data.files.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={skillTab === "overview"}
              className={`tab tab-xs sm:tab-sm font-semibold ${
                skillTab === "overview" ? "tab-active text-primary" : ""
              }`}
              onClick={() => setSkillTab("overview")}
            >
              Overview & Details
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col p-0 sm:p-6">
        {skillTab === "instructions" && (
          <div className="flex-1 overflow-hidden border-b border-base-300 bg-base-100 sm:rounded-xl sm:border sm:shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-300 bg-base-200/40 px-3.5 py-2 sm:px-4 sm:py-2.5">
              <span className="font-mono text-xs font-semibold text-base-content/75">
                SKILL.md
              </span>
              <div className="flex items-center gap-2">
                <div className="join border border-base-300 rounded-lg">
                  <button
                    type="button"
                    className={`btn btn-xs join-item ${
                      skillDocMode === "preview" ? "btn-primary" : "btn-ghost"
                    }`}
                    onClick={() => setSkillDocMode("preview")}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    className={`btn btn-xs join-item ${
                      skillDocMode === "source" ? "btn-primary" : "btn-ghost"
                    }`}
                    onClick={() => setSkillDocMode("source")}
                  >
                    Source
                  </button>
                </div>
                <button
                  type="button"
                  className="btn btn-outline btn-xs"
                  onClick={() => void handleCopyText(skillMdContent)}
                >
                  {copiedText ? "Copied!" : "Copy Content"}
                </button>
              </div>
            </div>

            {skillDocMode === "preview" ? (
              <MarkdownPreview
                content={skillMdContent}
                currentFilePath="SKILL.md"
              />
            ) : (
              <pre className="overflow-x-auto p-3.5 font-mono text-xs leading-relaxed text-base-content sm:p-6">
                <code>{skillMdContent}</code>
              </pre>
            )}
          </div>
        )}

        {skillTab === "files" && (
          <div className="grid flex-1 grid-cols-1 overflow-hidden border-b border-base-300 bg-base-100 sm:rounded-xl sm:border sm:shadow-sm md:grid-cols-[260px_1fr]">
            <aside
              aria-label="Skill snapshot files"
              className="max-h-36 overflow-y-auto border-b border-base-300 bg-base-200/30 p-2.5 md:max-h-none md:border-r md:border-b-0 md:p-3"
            >
              <div className="mb-1.5 px-2 text-[11px] font-bold uppercase tracking-wider text-base-content/55 sm:mb-2">
                Package Files ({data.files.length})
              </div>
              <ul className="space-y-1">
                {data.files.map((file) => {
                  const active = file.path === activeFileEntry?.path;
                  return (
                    <li key={file.path}>
                      <button
                        type="button"
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                          active
                            ? "bg-primary text-primary-content font-semibold"
                            : "hover:bg-base-300/60 text-base-content/85"
                        }`}
                        onClick={() => setSelectedSkillFile(file.path)}
                      >
                        <span className="truncate font-mono">{file.path}</span>
                        <span className="shrink-0 text-[10px] opacity-75">
                          {formatByteSize(file.size)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>

            <section className="flex flex-col overflow-hidden">
              {activeFileEntry ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-300 bg-base-200/40 px-3.5 py-2 sm:px-4 sm:py-2.5">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs font-bold text-base-content">
                        {activeFileEntry.path}
                      </code>
                      <span className="text-xs text-base-content/55">
                        ({formatByteSize(activeFileEntry.size)})
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {activeFileEntry.content !== undefined && (
                        <button
                          type="button"
                          className="btn btn-outline btn-xs"
                          onClick={() =>
                            void handleCopyText(activeFileEntry.content ?? "")
                          }
                        >
                          {copiedText ? "Copied!" : "Copy File"}
                        </button>
                      )}
                      <a
                        href={api.publicShareDownloadUrl(
                          data.id,
                          activeFileEntry.path,
                        )}
                        download
                        className="btn btn-ghost btn-xs"
                      >
                        Download File
                      </a>
                    </div>
                  </div>

                  {activeFileEntry.content !== undefined ? (
                    isMarkdownPath(activeFileEntry.path) ? (
                      <div className="overflow-y-auto">
                        <MarkdownPreview
                          content={activeFileEntry.content}
                          currentFilePath={activeFileEntry.path}
                        />
                      </div>
                    ) : (
                      <pre className="flex-1 overflow-auto p-3.5 font-mono text-xs leading-relaxed text-base-content sm:p-6">
                        <code>{activeFileEntry.content}</code>
                      </pre>
                    )
                  ) : (
                    <div className="p-6 text-center text-xs text-base-content/60 sm:p-8">
                      Binary file ({activeFileEntry.media_type}). Use Download
                      File to inspect locally.
                    </div>
                  )}
                </>
              ) : null}
            </section>
          </div>
        )}

        {skillTab === "overview" && (
          <div className="space-y-4 border-b border-base-300 bg-base-100 p-3.5 sm:space-y-6 sm:rounded-xl sm:border sm:p-6 sm:shadow-sm">
            <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-4">
              <div className="rounded-lg border border-base-300 bg-base-200/30 p-2.5 sm:p-3.5">
                <div className="text-[10px] font-semibold uppercase text-base-content/55 sm:text-[11px]">
                  Skill ID
                </div>
                <div className="mt-0.5 truncate font-mono text-xs font-bold sm:mt-1 sm:text-sm">
                  {data.target_path}
                </div>
              </div>
              <div className="rounded-lg border border-base-300 bg-base-200/30 p-2.5 sm:p-3.5">
                <div className="text-[10px] font-semibold uppercase text-base-content/55 sm:text-[11px]">
                  Category
                </div>
                <div className="mt-0.5 text-xs font-bold sm:mt-1 sm:text-sm">
                  {meta?.category || "standalone"}
                </div>
              </div>
              <div className="rounded-lg border border-base-300 bg-base-200/30 p-2.5 sm:p-3.5">
                <div className="text-[10px] font-semibold uppercase text-base-content/55 sm:text-[11px]">
                  Platforms
                </div>
                <div className="mt-0.5 text-xs font-bold sm:mt-1 sm:text-sm">
                  {meta?.platforms && meta.platforms.length > 0
                    ? meta.platforms.join(", ")
                    : "All platforms"}
                </div>
              </div>
              <div className="rounded-lg border border-base-300 bg-base-200/30 p-2.5 sm:p-3.5">
                <div className="text-[10px] font-semibold uppercase text-base-content/55 sm:text-[11px]">
                  Snapshot Revision
                </div>
                <div
                  className="mt-0.5 truncate font-mono text-xs sm:mt-1"
                  title={data.snapshot_revision}
                >
                  {data.snapshot_revision}
                </div>
              </div>
            </div>

            {meta?.prerequisites &&
              ((meta.prerequisites.env_vars &&
                meta.prerequisites.env_vars.length > 0) ||
                (meta.prerequisites.credential_files &&
                  meta.prerequisites.credential_files.length > 0)) && (
                <div className="rounded-lg border border-base-300 bg-base-200/20 p-4 space-y-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/70">
                    Prerequisites
                  </h3>
                  {meta.prerequisites.env_vars &&
                    meta.prerequisites.env_vars.length > 0 && (
                      <div className="text-xs">
                        <span className="font-semibold">
                          Environment Variables:{" "}
                        </span>
                        <span className="font-mono">
                          {meta.prerequisites.env_vars.join(", ")}
                        </span>
                      </div>
                    )}
                  {meta.prerequisites.credential_files &&
                    meta.prerequisites.credential_files.length > 0 && (
                      <div className="text-xs">
                        <span className="font-semibold">
                          Credential Files:{" "}
                        </span>
                        <span className="font-mono">
                          {meta.prerequisites.credential_files.join(", ")}
                        </span>
                      </div>
                    )}
                </div>
              )}

            <div>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-base-content/70">
                Snapshotted Files ({data.files.length})
              </h3>
              <div className="overflow-x-auto rounded-lg border border-base-300">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th>Path</th>
                      <th>Media Type</th>
                      <th>Size</th>
                      <th>Modified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.files.map((f) => (
                      <tr key={f.path}>
                        <td className="font-mono text-xs">{f.path}</td>
                        <td className="text-xs text-base-content/70">
                          {f.media_type}
                        </td>
                        <td className="text-xs">{formatByteSize(f.size)}</td>
                        <td className="text-xs text-base-content/70">
                          {formatShareTimestamp(f.modified_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </section>
  );
}
