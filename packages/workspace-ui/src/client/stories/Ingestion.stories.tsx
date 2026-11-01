import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { IngestionSection } from "../IngestionSection";
import { DocumentCard } from "../ingestion/DocumentCard";
import {
  DocumentFilterBar,
  type IngestionScope,
  type ReviewFilter,
} from "../ingestion/DocumentFilterBar";
import { DocumentInspector } from "../ingestion/DocumentInspector";
import { PasswordManagerModal } from "../ingestion/PasswordManagerModal";
import { UploadModal } from "../ingestion/UploadModal";
import { action, storyData, storyLoader } from "./fixtures";
import { PageFrame } from "./frames";

const meta = {
  title: "Ingestion/Documents",
  loaders: [storyLoader],
  parameters: {
    layout: "fullscreen",
    componentExports: [
      "IngestionSection.tsx#IngestionSection",
      "ingestion/DocumentCard.tsx#DocumentCard",
      "ingestion/DocumentFilterBar.tsx#DocumentFilterBar",
      "ingestion/DocumentInspector.tsx#DocumentInspector",
      "ingestion/PasswordManagerModal.tsx#PasswordManagerModal",
      "ingestion/UploadModal.tsx#UploadModal",
    ],
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Card: Story = {
  render: function CardStory(_args, { loaded }) {
    const data = storyData(loaded);
    const [selected, select] = useState(false);
    return (
      <div className="max-w-md">
        <DocumentCard
          item={data.sourceItem}
          isSelected={selected}
          onSelect={() => select(!selected)}
        />
      </div>
    );
  },
};
export const Filters: Story = {
  render: function FiltersStory(_args, { loaded }) {
    const data = storyData(loaded);
    const [scope, setScope] = useState<IngestionScope>("library");
    const [review, setReview] = useState<ReviewFilter>("all");
    const [search, setSearch] = useState("");
    return (
      <DocumentFilterBar
        scope={scope}
        onScopeChange={setScope}
        reviewFilter={review}
        onReviewFilterChange={setReview}
        searchQuery={search}
        onSearchChange={setSearch}
        onTagChange={action("tag")}
        onCorrespondentChange={action("correspondent")}
        onDocTypeChange={action("documentType")}
        facets={data.sourceSearch.facets}
        onOpenUpload={action("upload")}
        onOpenPasswordManager={action("passwordManager")}
      />
    );
  },
};
export const Inspector: Story = {
  render: (_args, { loaded }) => {
    const data = storyData(loaded);
    return (
      <PageFrame>
        <DocumentInspector
          api={data.api}
          document={data.source}
          loading={false}
          onUpdate={action("updateDocument")}
          onOpenFile={action("openFile")}
          rawUrl={data.api.rawUrl}
        />
      </PageFrame>
    );
  },
};
export const Library: Story = {
  render: (_args, { loaded }) => {
    const data = storyData(loaded);
    return (
      <PageFrame>
        <IngestionSection
          api={data.api}
          overview={data.ingestion}
          detail={null}
          detailLoading={false}
          loading={false}
          onOpenFile={action("openFile")}
          onRefresh={action("refresh")}
          onSelect={action("select")}
          rawUrl={data.api.rawUrl}
        />
      </PageFrame>
    );
  },
};
export const LongInspector: Story = {
  render: (_args, { loaded }) => {
    const data = storyData(loaded);
    return (
      <PageFrame>
        <DocumentInspector
          api={{ ...data.api, sourceRawUrl: () => "about:blank" }}
          document={{
            ...data.source,
            content: `${Array.from(
              { length: 50 },
              (_, i) =>
                `OCR paragraph ${i + 1}: all extracted content must remain reachable.`,
            ).join("\n\n")}\n\nEnd of extracted content`,
          }}
          loading={false}
          onUpdate={action("updateDocument")}
          onOpenFile={action("openFile")}
          rawUrl={data.api.rawUrl}
        />
      </PageFrame>
    );
  },
};
export const Upload: Story = {
  parameters: { docs: { story: { inline: false } } },
  render: (_args, { loaded }) => (
    <UploadModal
      api={storyData(loaded).api}
      isOpen
      onClose={action("close")}
      onSuccess={action("uploaded")}
      initialFiles={[
        new File(["# Component review"], "review.md", {
          type: "text/markdown",
        }),
      ]}
    />
  ),
};
export const PasswordProfiles: Story = {
  parameters: { docs: { story: { inline: false } } },
  render: (_args, { loaded }) => (
    <PasswordManagerModal
      api={storyData(loaded).api}
      isOpen
      onClose={action("close")}
      onChanged={action("changed")}
    />
  ),
};
