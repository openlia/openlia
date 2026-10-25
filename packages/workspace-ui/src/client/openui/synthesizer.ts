import type { WorkspaceDomainInfo } from "../../shared/api";

export interface SynthesizedOpenUIResult {
  dashboardOpenUI: string;
  recordOpenUI: string;
}

const CHECKLIST_HEADING_KEYWORDS = [
  "task",
  "action",
  "checklist",
  "milestone",
  "subtask",
  "step",
  "loop",
  "follow-up",
  "follow up",
  "items",
  "sub-tasks",
  "key result",
];

export function isChecklistHeading(heading: string): boolean {
  const lower = heading.toLowerCase().trim();
  return CHECKLIST_HEADING_KEYWORDS.some((kw) => lower.includes(kw));
}

export function synthesizeDomainOpenUI(
  domainPath: string,
  domainInfo?: WorkspaceDomainInfo,
  schemaJson?: Record<string, unknown>,
  templateHeadings: string[] = [],
): SynthesizedOpenUIResult {
  const domainName =
    domainPath
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/[-_]/g, " ")
      ?.replace(/\b\w/g, (c) => c.toUpperCase()) || "Domain";

  const description =
    domainInfo?.purpose ?? `Manage and explore ${domainName} records.`;
  const schemaProps =
    (schemaJson?.properties as Record<string, Record<string, unknown>>) ?? {};

  // 1. Dashboard synthesis
  const hasStatus = "status" in schemaProps;
  const hasPriority = "priority" in schemaProps;

  const dashboardStatements: string[] = [
    `hdr = DomainHeader("${domainName}", "${description.replace(/"/g, '\\"')}")`,
  ];
  const rootChildren: string[] = ["hdr"];

  if (hasStatus) {
    dashboardStatements.push('kb = RecordKanban("status")');
    rootChildren.push("kb");
  }

  dashboardStatements.push("tbl = RecordTable()");
  rootChildren.push("tbl");

  dashboardStatements.push(`root = Stack([${rootChildren.join(", ")}])`);
  const dashboardOpenUI = dashboardStatements.join("\n");

  // 2. Record visual synthesis
  const recordStatements: string[] = [
    "hdr = RecordHeaderCard()",
    "props = FrontmatterEditorCard()",
  ];
  const recordChildren: string[] = ["hdr", "props"];

  // Filter out the H1 title if present in headings
  const headings = templateHeadings.filter(
    (h) => h.toLowerCase() !== domainName.toLowerCase(),
  );

  if (headings.length > 0) {
    headings.forEach((heading, idx) => {
      const varName = `sec${idx + 1}`;
      const escapedHeading = heading.replace(/"/g, '\\"');
      if (isChecklistHeading(heading)) {
        recordStatements.push(
          `${varName} = ChecklistSection("${escapedHeading}")`,
        );
      } else {
        recordStatements.push(
          `${varName} = MarkdownSectionCard("${escapedHeading}")`,
        );
      }
      recordChildren.push(varName);
    });
  } else {
    // Default sections if none found
    recordStatements.push('notes = MarkdownSectionCard("Notes")');
    recordChildren.push("notes");
  }

  recordStatements.push(`root = Stack([${recordChildren.join(", ")}])`);
  const recordOpenUI = recordStatements.join("\n");

  return {
    dashboardOpenUI,
    recordOpenUI,
  };
}

// Pre-curated default OpenUI Lang programs for core & feature domains
export const DEFAULT_DOMAIN_OPENUI: Record<string, SynthesizedOpenUIResult> = {
  tasks: {
    dashboardOpenUI: [
      'hdr = DomainHeader("Tasks", "Actionable items, chores, and workstreams")',
      'kb = RecordKanban("status")',
      "tbl = RecordTable()",
      "root = Stack([hdr, kb, tbl])",
    ].join("\n"),
    recordOpenUI: [
      "hdr = RecordHeaderCard()",
      "props = FrontmatterEditorCard()",
      'substeps = ChecklistSection("Substeps")',
      'notes = MarkdownSectionCard("Notes")',
      "root = Stack([hdr, props, substeps, notes])",
    ].join("\n"),
  },
  projects: {
    dashboardOpenUI: [
      'hdr = DomainHeader("Projects", "Multi-step initiatives driving towards concrete outcomes")',
      'kb = RecordKanban("status")',
      "tbl = RecordTable()",
      "root = Stack([hdr, kb, tbl])",
    ].join("\n"),
    recordOpenUI: [
      "hdr = RecordHeaderCard()",
      "props = FrontmatterEditorCard()",
      'obj = MarkdownSectionCard("Objective")',
      'milestones = ChecklistSection("Milestones")',
      'nextTasks = ChecklistSection("Next Tasks")',
      'risks = MarkdownSectionCard("Risks and Assumptions")',
      "root = Stack([hdr, props, obj, milestones, nextTasks, risks])",
    ].join("\n"),
  },
  goals: {
    dashboardOpenUI: [
      'hdr = DomainHeader("Goals", "High-level objectives and review rhythms")',
      'kb = RecordKanban("status")',
      "tbl = RecordTable()",
      "root = Stack([hdr, kb, tbl])",
    ].join("\n"),
    recordOpenUI: [
      "hdr = RecordHeaderCard()",
      "props = FrontmatterEditorCard()",
      'obj = MarkdownSectionCard("Objective")',
      'krs = ChecklistSection("Key Results")',
      'actions = ChecklistSection("Next Actions")',
      "root = Stack([hdr, props, obj, krs, actions])",
    ].join("\n"),
  },
  inbox: {
    dashboardOpenUI: [
      'hdr = DomainHeader("Inbox", "Raw captures awaiting triage and categorization")',
      "tbl = RecordTable()",
      "root = Stack([hdr, tbl])",
    ].join("\n"),
    recordOpenUI: [
      "hdr = RecordHeaderCard()",
      "props = FrontmatterEditorCard()",
      'capture = MarkdownSectionCard("Capture Details")',
      'next = ChecklistSection("Triage Next Steps")',
      "root = Stack([hdr, props, capture, next])",
    ].join("\n"),
  },
  "knowledge/claims": {
    dashboardOpenUI: [
      'hdr = DomainHeader("Claims Ledger", "Atomic assertions, evidence, and provenance ledger")',
      'kb = RecordKanban("status")',
      "tbl = RecordTable()",
      "root = Stack([hdr, kb, tbl])",
    ].join("\n"),
    recordOpenUI: [
      "hdr = RecordHeaderCard()",
      "prov = ClaimProvenanceCard()",
      "props = FrontmatterEditorCard()",
      'claim = MarkdownSectionCard("Claim")',
      'evidence = MarkdownSectionCard("Evidence & Context")',
      "root = Stack([hdr, prov, props, claim, evidence])",
    ].join("\n"),
  },
  decisions: {
    dashboardOpenUI: [
      'hdr = DomainHeader("Decisions", "Architectural and personal decisions registry")',
      'kb = RecordKanban("status")',
      "tbl = RecordTable()",
      "root = Stack([hdr, kb, tbl])",
    ].join("\n"),
    recordOpenUI: [
      "hdr = RecordHeaderCard()",
      "matrix = DecisionMatrixCard()",
      "props = FrontmatterEditorCard()",
      'context = MarkdownSectionCard("Context & Problem")',
      'consequences = MarkdownSectionCard("Consequences")',
      "root = Stack([hdr, matrix, props, context, consequences])",
    ].join("\n"),
  },
  ideas: {
    dashboardOpenUI: [
      'hdr = DomainHeader("Ideas", "Sparks, incubation concepts, and exploratory topics")',
      'kb = RecordKanban("status")',
      "tbl = RecordTable()",
      "root = Stack([hdr, kb, tbl])",
    ].join("\n"),
    recordOpenUI: [
      "hdr = RecordHeaderCard()",
      "props = FrontmatterEditorCard()",
      'concept = MarkdownSectionCard("Concept")',
      'questions = ChecklistSection("Key Questions")',
      'next = ChecklistSection("Next Exploration Step")',
      "root = Stack([hdr, props, concept, questions, next])",
    ].join("\n"),
  },
  people: {
    dashboardOpenUI: [
      'hdr = DomainHeader("People", "Network, relationships, and touchpoints")',
      "tbl = RecordTable()",
      "root = Stack([hdr, tbl])",
    ].join("\n"),
    recordOpenUI: [
      "hdr = RecordHeaderCard()",
      "props = FrontmatterEditorCard()",
      'profile = MarkdownSectionCard("Profile & Context")',
      'loops = ChecklistSection("Open Loops & Follow-ups")',
      "root = Stack([hdr, props, profile, loops])",
    ].join("\n"),
  },
};
