import { useCallback, useEffect, useMemo, useState } from "react";
import type { PublicShareResponse } from "../shared/api";
import { ApiError, httpWorkspaceApi, type WorkspaceApi } from "./api";
import { CalendarPreviewPane } from "./calendar/CalendarPreviewPane";
import { isJournalPath, isMarkdownPath, isRemindPath } from "./CodeEditor";
import { MarkdownPreview } from "./components/editor/MarkdownPreview";
import { JournalPreviewPane } from "./journal/JournalPreviewPane";
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

  const filesByPath = useMemo(() => {
    const map = new Map<
      string,
      PublicShareResponse["share"]["files"][number]
    >();
    if (!data) return map;
    for (const f of data.files) {
      map.set(f.path, f);
      map.set(f.path.replace(/^\/+/, ""), f);
    }
    return map;
  }, [data]);

  const handleLoadSnapshotInclude = useCallback(
    async (resolvedPath: string): Promise<string | null> => {
      const clean = resolvedPath.replace(/^\/+/, "");
      const direct = filesByPath.get(clean);
      if (direct?.content !== undefined) return direct.content;
      const base = clean.split("/").at(-1);
      if (base) {
        for (const [key, entry] of filesByPath.entries()) {
          if (key.endsWith(`/${base}`) || key === base) {
            if (entry.content !== undefined) return entry.content;
          }
        }
      }
      return null;
    },
    [filesByPath],
  );

  const handleLoadSnapshotCalendarFile = useCallback(
    async (
      resolvedPath: string,
    ): Promise<{ content: string; revision: string }> => {
      const content = await handleLoadSnapshotInclude(resolvedPath);
      if (content === null) {
        throw new Error("Included calendar file not in snapshot");
      }
      return {
        content,
        revision: data?.snapshot_revision ?? "sha256:snapshot",
      };
    },
    [handleLoadSnapshotInclude, data?.snapshot_revision],
  );

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
    const isJournal = isJournalPath(data.target_path);
    const isRemind = isRemindPath(data.target_path);
    const hasRichPreview =
      data.editable && (isMarkdown || isJournal || isRemind);
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
        <header className="border-b border-base-300 bg-base-100 px-6 py-4 shadow-xs">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-extrabold uppercase tracking-widest text-primary">
                  OPENLIA / SHARED DOCUMENT
                </span>
                <span className="badge badge-ghost badge-xs font-mono">
                  {data.target_path}
                </span>
                <span className="badge badge-outline badge-xs">
                  {formatExpirationSummary(data.expires_at)}
                </span>
              </div>
              <h1 className="mt-1 truncate text-xl font-bold text-base-content">
                {data.title}
              </h1>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-base-content/60">
                <span>Snapshotted {formatShareTimestamp(data.updated_at)}</span>
                <span>·</span>
                <span>{formatByteSize(data.total_bytes)}</span>
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

            <div className="flex flex-wrap items-center gap-2">
              {hasRichPreview && (
                <fieldset
                  aria-label="View mode"
                  className="join border border-base-300 rounded-lg"
                >
                  <button
                    type="button"
                    className={`btn btn-xs join-item ${
                      docViewMode === "preview" ? "btn-primary" : "btn-ghost"
                    }`}
                    onClick={() => setDocViewMode("preview")}
                  >
                    {isJournal
                      ? "Visual Journal"
                      : isRemind
                        ? "Calendar View"
                        : "Rendered Preview"}
                  </button>
                  <button
                    type="button"
                    className={`btn btn-xs join-item ${
                      docViewMode === "raw" ? "btn-primary" : "btn-ghost"
                    }`}
                    onClick={() => setDocViewMode("raw")}
                  >
                    Raw Source
                  </button>
                </fieldset>
              )}

              {data.editable && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => void handleCopyText(primaryContent)}
                >
                  {copiedText ? "Copied!" : "Copy Content"}
                </button>
              )}

              <a href={downloadUrl} download className="btn btn-primary btn-sm">
                Download File
              </a>
            </div>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col p-6">
          <div className="flex-1 overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-sm">
            {data.editable ? (
              docViewMode === "preview" && isMarkdown ? (
                <div className="p-6">
                  <MarkdownPreview
                    content={primaryContent}
                    currentFilePath={data.target_path}
                  />
                </div>
              ) : docViewMode === "preview" && isJournal ? (
                <div className="h-full min-h-[36rem]">
                  <JournalPreviewPane
                    content={primaryContent}
                    filePath={data.target_path}
                    onLoadInclude={handleLoadSnapshotInclude}
                  />
                </div>
              ) : docViewMode === "preview" && isRemind ? (
                <div className="h-full min-h-[36rem]">
                  <CalendarPreviewPane
                    content={primaryContent}
                    filePath={data.target_path}
                    fileRevision={data.snapshot_revision}
                    onLoadCalendarFile={handleLoadSnapshotCalendarFile}
                  />
                </div>
              ) : (
                <pre className="overflow-x-auto p-6 font-mono text-xs leading-relaxed text-base-content">
                  <code>{primaryContent}</code>
                </pre>
              )
            ) : (
              <div className="flex flex-col items-center justify-center gap-4 p-8">
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
      <header className="border-b border-base-300 bg-base-100 px-6 py-5 shadow-xs">
        <div className="mx-auto max-w-6xl space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-extrabold uppercase tracking-widest text-secondary">
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

              <h1 className="text-2xl font-bold text-base-content">
                {meta?.name || data.title}
              </h1>
              {meta?.description && (
                <p className="max-w-3xl text-sm text-base-content/75">
                  {meta.description}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-base-content/60">
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
                className="btn btn-primary btn-sm gap-2"
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
            className="tabs tabs-bordered pt-2"
          >
            <button
              type="button"
              role="tab"
              aria-selected={skillTab === "instructions"}
              className={`tab tab-sm font-semibold ${
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
              className={`tab tab-sm font-semibold ${
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
              className={`tab tab-sm font-semibold ${
                skillTab === "overview" ? "tab-active text-primary" : ""
              }`}
              onClick={() => setSkillTab("overview")}
            >
              Overview & Details
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col p-6">
        {skillTab === "instructions" && (
          <div className="flex-1 overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-300 bg-base-200/40 px-4 py-2.5">
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
              <div className="p-6">
                <MarkdownPreview
                  content={skillMdContent}
                  currentFilePath="SKILL.md"
                />
              </div>
            ) : (
              <pre className="overflow-x-auto p-6 font-mono text-xs leading-relaxed text-base-content">
                <code>{skillMdContent}</code>
              </pre>
            )}
          </div>
        )}

        {skillTab === "files" && (
          <div className="grid flex-1 grid-cols-1 overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-sm md:grid-cols-[260px_1fr]">
            <aside
              aria-label="Skill snapshot files"
              className="border-b border-base-300 bg-base-200/30 p-3 md:border-r md:border-b-0"
            >
              <div className="mb-2 px-2 text-[11px] font-bold uppercase tracking-wider text-base-content/55">
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
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-300 bg-base-200/40 px-4 py-2.5">
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
                      <div className="p-6 overflow-y-auto">
                        <MarkdownPreview
                          content={activeFileEntry.content}
                          currentFilePath={activeFileEntry.path}
                        />
                      </div>
                    ) : (
                      <pre className="flex-1 overflow-auto p-6 font-mono text-xs leading-relaxed text-base-content">
                        <code>{activeFileEntry.content}</code>
                      </pre>
                    )
                  ) : (
                    <div className="p-8 text-center text-xs text-base-content/60">
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
          <div className="space-y-6 rounded-xl border border-base-300 bg-base-100 p-6 shadow-sm">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-base-300 bg-base-200/30 p-3.5">
                <div className="text-[11px] font-semibold uppercase text-base-content/55">
                  Skill ID
                </div>
                <div className="mt-1 font-mono text-sm font-bold">
                  {data.target_path}
                </div>
              </div>
              <div className="rounded-lg border border-base-300 bg-base-200/30 p-3.5">
                <div className="text-[11px] font-semibold uppercase text-base-content/55">
                  Category
                </div>
                <div className="mt-1 text-sm font-bold">
                  {meta?.category || "standalone"}
                </div>
              </div>
              <div className="rounded-lg border border-base-300 bg-base-200/30 p-3.5">
                <div className="text-[11px] font-semibold uppercase text-base-content/55">
                  Platforms
                </div>
                <div className="mt-1 text-sm font-bold">
                  {meta?.platforms && meta.platforms.length > 0
                    ? meta.platforms.join(", ")
                    : "All platforms"}
                </div>
              </div>
              <div className="rounded-lg border border-base-300 bg-base-200/30 p-3.5">
                <div className="text-[11px] font-semibold uppercase text-base-content/55">
                  Snapshot Revision
                </div>
                <div
                  className="mt-1 truncate font-mono text-xs"
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
