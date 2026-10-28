import type { WorkspaceStarterTemplate } from "./api";

export interface BuiltinDomainContract {
  path: string;
  label: string;
  template_path: string;
  schema_path?: string | undefined;
  purpose: string;
  schema_json?: Record<string, unknown> | undefined;
  template_headings: string[];
  template_content: string;
  template_defaults: Record<string, unknown>;
  template_sections: Record<string, string>;
  starter_templates?: WorkspaceStarterTemplate[] | undefined;
}

const KNOWLEDGE_PROJECT_NOTE_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "OpenLia Knowledge Project Note Frontmatter",
  type: "object",
  additionalProperties: true,
  required: ["status"],
  properties: {
    kind: {
      type: "string",
      enum: ["project", "note"],
      description: "Archetype of the vault note.",
    },
    status: {
      type: "string",
      enum: ["active", "paused", "completed", "archived"],
      description: "Current lifecycle state of the project.",
    },
    owner: {
      type: ["string", "null"],
      description: "Primary project owner or lead.",
    },
    target_completion: {
      type: ["string", "null"],
      format: "date",
      description: "Target completion date (YYYY-MM-DD).",
    },
    linked_goal: {
      type: ["string", "null"],
      description: "Associated goal record or outcome.",
    },
    linked_area: {
      type: ["string", "null"],
      description: "Associated area of responsibility.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Tags for organizing vault notes.",
    },
  },
};

const KNOWLEDGE_PROJECT_NOTE_SECTIONS: Record<string, string> = {
  Objective: "[State the specific outcome this project is meant to achieve.]",
  Constraints:
    "- Budget / resources:\n- Timeline / deadlines:\n- Scope boundaries:",
  Milestones:
    "- [ ] Milestone 1 — target date\n- [ ] Milestone 2 — target date",
  "Next Tasks": "- [ ] Next concrete action (`openlia://workspace/tasks/...`)",
  "Risks & Open Issues": "- Risk or open question:",
  "Key Decisions":
    "- Related decision records (`openlia://workspace/decisions/...`):",
};

const KNOWLEDGE_PROJECT_NOTE_CONTENT = `---
kind: project
status: active
owner: null
target_completion: null
linked_goal: null
linked_area: null
tags: []
---

# <Project Title>

## Objective

[State the specific outcome this project is meant to achieve.]

## Constraints

- Budget / resources:
- Timeline / deadlines:
- Scope boundaries:

## Milestones

- [ ] Milestone 1 — target date
- [ ] Milestone 2 — target date

## Next Tasks

- [ ] Next concrete action (\`openlia://workspace/tasks/...\`)

## Risks & Open Issues

- Risk or open question:

## Key Decisions

- Related decision records (\`openlia://workspace/decisions/...\`):
`;

const KNOWLEDGE_ATOMIC_NOTE_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "OpenLia Knowledge Atomic Note Frontmatter",
  type: "object",
  additionalProperties: true,
  properties: {
    kind: {
      type: "string",
      enum: ["note", "project", "reference"],
      description: "Archetype of the vault note.",
    },
    linked_project: {
      type: ["string", "null"],
      description: "Associated project note or goal.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Tags for organizing vault notes.",
    },
    links: {
      type: "array",
      items: { type: "string" },
      description:
        "Canonical openlia://workspace/... or openlia://source/... links.",
    },
  },
};

const KNOWLEDGE_ATOMIC_NOTE_SECTIONS: Record<string, string> = {
  Summary: "[Concise summary of the concept, insight, or reference.]",
  Notes: "- Key points and observations:",
  References:
    "- Related notes (`openlia://workspace/knowledge/...`):\n- Sources (`openlia://source/...`):",
};

const KNOWLEDGE_ATOMIC_NOTE_CONTENT = `---
kind: note
linked_project: null
tags: []
links: []
---

# <Note Title>

## Summary

[Concise summary of the concept, insight, or reference.]

## Notes

- Key points and observations:

## References

- Related notes (\`openlia://workspace/knowledge/...\`):
- Sources (\`openlia://source/...\`):
`;

const KNOWLEDGE_STARTER_TEMPLATES: WorkspaceStarterTemplate[] = [
  {
    id: "project-note",
    label: "Project Note",
    description:
      "Structured PKM project page (e.g. project-apollo.md) with objective, owner, target completion, milestones, and linked decisions/tasks.",
    schema_json: KNOWLEDGE_PROJECT_NOTE_SCHEMA,
    template_headings: Object.keys(KNOWLEDGE_PROJECT_NOTE_SECTIONS),
    template_content: KNOWLEDGE_PROJECT_NOTE_CONTENT,
    template_defaults: {
      kind: "project",
      status: "active",
      owner: null,
      target_completion: null,
      linked_goal: null,
      linked_area: null,
      tags: [],
    },
    template_sections: KNOWLEDGE_PROJECT_NOTE_SECTIONS,
  },
  {
    id: "atomic-note",
    label: "Atomic Note",
    description:
      "Evergreen concept or reference note with summary, notes, tags, and openlia:// backlinks.",
    schema_json: KNOWLEDGE_ATOMIC_NOTE_SCHEMA,
    template_headings: Object.keys(KNOWLEDGE_ATOMIC_NOTE_SECTIONS),
    template_content: KNOWLEDGE_ATOMIC_NOTE_CONTENT,
    template_defaults: {
      kind: "note",
      linked_project: null,
      tags: [],
      links: [],
    },
    template_sections: KNOWLEDGE_ATOMIC_NOTE_SECTIONS,
  },
  {
    id: "blank-note",
    label: "Blank Note",
    description:
      "Pure free-form Markdown note without frontmatter or predefined sections.",
    template_headings: [],
    template_content: "# <Note Title>\n\n",
    template_defaults: {},
    template_sections: {},
  },
];

export const BUILTIN_DOMAIN_CONTRACTS: Record<string, BuiltinDomainContract> = {
  knowledge: {
    path: "knowledge",
    label: "Knowledge",
    template_path: "knowledge/project-note",
    purpose:
      "Obsidian-style free-form PKM vault for notes, project pages (e.g. project-apollo.md), and subfolders.",
    schema_json: KNOWLEDGE_PROJECT_NOTE_SCHEMA,
    template_headings: Object.keys(KNOWLEDGE_PROJECT_NOTE_SECTIONS),
    template_content: KNOWLEDGE_PROJECT_NOTE_CONTENT,
    template_defaults: {
      kind: "project",
      status: "active",
      owner: null,
      target_completion: null,
      linked_goal: null,
      linked_area: null,
      tags: [],
    },
    template_sections: KNOWLEDGE_PROJECT_NOTE_SECTIONS,
    starter_templates: KNOWLEDGE_STARTER_TEMPLATES,
  },
  decisions: {
    path: "decisions",
    label: "Decisions",
    template_path: "decisions/decision-template.md",
    schema_path: "decisions/decision-template.schema.json",
    purpose: "Questions, options, trade-offs, and outcomes.",
    schema_json: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "OpenLia Decision Record Frontmatter",
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: {
          type: "string",
          enum: [
            "proposed",
            "under-review",
            "accepted",
            "decided",
            "superseded",
            "abandoned",
          ],
          description: "Current decision lifecycle state.",
        },
        decision_date: {
          type: ["string", "null"],
          format: "date",
          description: "Target or actual decision date (YYYY-MM-DD).",
        },
        review_date: {
          type: ["string", "null"],
          format: "date",
          description: "Date to review the outcome of this decision.",
        },
        linked_project: {
          type: ["string", "null"],
          description:
            "Associated project note (e.g. knowledge/project-apollo.md) or goal.",
        },
        chosen_option: {
          type: ["string", "null"],
          description:
            "Selected option once decided (leave unselected while status is proposed).",
        },
      },
    },
    template_headings: [
      "Question",
      "Context And Constraints",
      "Options Considered",
      "Criteria And Weights",
      "Evidence & Claims",
      "Recommendation",
      "Chosen Option & Rationale",
      "Next Actions",
      "Review Outcome",
    ],
    template_defaults: {
      status: "proposed",
      decision_date: null,
      review_date: null,
      linked_project: null,
      chosen_option: null,
    },
    template_sections: {
      Question: "[State the specific decision question to resolve.]",
      "Context And Constraints":
        "- Trigger:\n- Hard constraints:\n- Decision deadline:",
      "Options Considered": "- **Option A**:\n- **Option B**:",
      "Criteria And Weights":
        "- Criterion 1 (weight):\n- Criterion 2 (weight):",
      "Evidence & Claims": "- Supporting facts or source citations:",
      Recommendation:
        "[Summarize the leading option or why the decision remains open.]",
      "Chosen Option & Rationale":
        "[Leave unselected while status is proposed; record the chosen option and rationale once decided.]",
      "Next Actions": "- [ ] Follow-up action",
      "Review Outcome": "- Expected outcome:\n- Actual outcome on review date:",
    },
    template_content: `---
$schema: ./decision-template.schema.json
status: proposed
decision_date: null
review_date: null
linked_project: null
chosen_option: null
---

# <Decision Title>

## Question

[State the specific decision question to resolve.]

## Context And Constraints

- Trigger:
- Hard constraints:
- Decision deadline:

## Options Considered

- **Option A**:
- **Option B**:

## Criteria And Weights

- Criterion 1 (weight):
- Criterion 2 (weight):

## Evidence & Claims

- Supporting facts or source citations:

## Recommendation

[Summarize the leading option or why the decision remains open.]

## Chosen Option & Rationale

[Leave unselected while status is proposed; record the chosen option and rationale once decided.]

## Next Actions

- [ ] Follow-up action

## Review Outcome

- Expected outcome:
- Actual outcome on review date:
`,
  },
  tasks: {
    path: "tasks",
    label: "Tasks",
    template_path: "tasks/task-template.md",
    schema_path: "tasks/task-template.schema.json",
    purpose: "Concrete actions that can be completed.",
    schema_json: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "OpenLia Task Frontmatter",
      type: "object",
      additionalProperties: false,
      required: ["status", "priority"],
      properties: {
        status: {
          type: "string",
          enum: ["todo", "in-progress", "waiting", "done", "cancelled"],
          description: "Current execution state of the task.",
        },
        priority: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Relative urgency/importance of the task.",
        },
        owner: {
          type: ["string", "null"],
          description: "Person responsible for completing the task.",
        },
        due_date: {
          type: ["string", "null"],
          format: "date",
          description: "Target completion date (YYYY-MM-DD).",
        },
        linked_project: {
          type: ["string", "null"],
          description:
            "Associated project note (e.g. knowledge/project-apollo.md) or goal.",
        },
        linked_area: {
          type: ["string", "null"],
          description: "Associated area of responsibility.",
        },
        context_tags: {
          type: "array",
          items: {
            type: "string",
            enum: ["#computer", "#phone", "#errand", "#home", "#work"],
          },
          uniqueItems: true,
          description: "Execution context tags.",
        },
        completed_at: {
          type: ["string", "null"],
          format: "date",
          description: "Date when the task was completed (YYYY-MM-DD).",
        },
      },
    },
    template_headings: ["Action", "Checklist / Substeps", "Completion Note"],
    template_defaults: {
      status: "todo",
      priority: "medium",
      owner: null,
      due_date: null,
      linked_project: null,
      linked_area: null,
      context_tags: ["#work"],
      completed_at: null,
    },
    template_sections: {
      Action:
        "[Describe the concrete physical next action and definition of done.]",
      "Checklist / Substeps": "- [ ] Step 1\n- [ ] Step 2",
      "Completion Note": "- Outcome / artifacts:",
    },
    template_content: `---
$schema: ./task-template.schema.json
status: todo
priority: medium
owner: null
due_date: null
linked_project: null
linked_area: null
context_tags:
  - "#work"
completed_at: null
---

# <Task Title>

## Action

[Describe the concrete physical next action and definition of done.]

## Checklist / Substeps

- [ ] Step 1
- [ ] Step 2

## Completion Note

- Outcome / artifacts:
`,
  },
  goals: {
    path: "goals",
    label: "Goals",
    template_path: "goals/goal-template.md",
    schema_path: "goals/goal-template.schema.json",
    purpose: "Outcomes and the reasons they matter.",
    schema_json: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "OpenLia Goal Frontmatter",
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: {
          type: "string",
          enum: ["active", "paused", "achieved", "archived"],
          description: "Current goal lifecycle state.",
        },
        owner: {
          type: ["string", "null"],
          description: "Primary owner of this goal.",
        },
        target_completion: {
          type: ["string", "null"],
          format: "date",
          description: "Target completion date (YYYY-MM-DD).",
        },
        linked_area: {
          type: ["string", "null"],
          description: "Associated area of responsibility.",
        },
        review_cadence: {
          type: ["string", "null"],
          enum: ["weekly", "monthly", "quarterly", null],
          description: "How often this goal is reviewed.",
        },
      },
    },
    template_headings: [
      "Outcome",
      "Why It Matters",
      "Success Criteria",
      "Milestones",
      "Linked Projects & Tasks",
      "Review Notes",
    ],
    template_defaults: {
      status: "active",
      owner: null,
      target_completion: null,
      linked_area: null,
      review_cadence: "monthly",
    },
    template_sections: {
      Outcome: "[State the high-level outcome to achieve.]",
      "Why It Matters": "[Explain the motivation and impact.]",
      "Success Criteria": "- Criterion 1:\n- Criterion 2:",
      Milestones: "- [ ] Milestone 1",
      "Linked Projects & Tasks": "- Project / task links:",
      "Review Notes": "- Progress notes:",
    },
    template_content: `---
$schema: ./goal-template.schema.json
status: active
owner: null
target_completion: null
linked_area: null
review_cadence: monthly
---

# <Goal Title>

## Outcome

[State the high-level outcome to achieve.]

## Why It Matters

[Explain the motivation and impact.]

## Success Criteria

- Criterion 1:
- Criterion 2:

## Milestones

- [ ] Milestone 1

## Linked Projects & Tasks

- Project / task links:

## Review Notes

- Progress notes:
`,
  },
};

export function getBuiltinDomainContract(
  domainPath: string,
): BuiltinDomainContract | undefined {
  const normalized = domainPath.trim().replace(/^\/+|\/+$/g, "");
  return BUILTIN_DOMAIN_CONTRACTS[normalized];
}

/**
 * Merges additive properties from BUILTIN_DOMAIN_CONTRACTS into a disk-loaded
 * schema JSON so older workspace copies still expose fields such as
 * `linked_project`, `chosen_option`, and `owner`.
 */
export function mergeBuiltinSchemaProperties(
  domainPath: string,
  diskSchema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const builtin = getBuiltinDomainContract(domainPath);
  if (!builtin?.schema_json) return diskSchema;
  if (!diskSchema) return builtin.schema_json;

  const builtinProps =
    builtin.schema_json.properties &&
    typeof builtin.schema_json.properties === "object"
      ? (builtin.schema_json.properties as Record<string, unknown>)
      : {};
  const diskProps =
    diskSchema.properties && typeof diskSchema.properties === "object"
      ? (diskSchema.properties as Record<string, unknown>)
      : {};

  return {
    ...diskSchema,
    properties: {
      ...builtinProps,
      ...diskProps,
    },
  };
}
