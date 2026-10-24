---
name: project-review
description: Assess project health and surface next actions.
version: 0.1.0
platforms: [macos, linux]
required_environment_variables: []
required_credential_files: []
workspace_domains:
  - projects
metadata:
  hermes:
    tags: [personal-os, projects, review]
    category: productivity
---

# Project Review

## When to Use

Use when a project needs a status check grounded in its objective, milestones,
tasks, risks, and decisions.

## Procedure

1. Read one project record and its directly linked records.
2. Read `workspace.yaml` and resolve the registered project template and schema
   before interpreting or updating the project record. The workspace
   [Project Template](openlia://workspace/projects/project-template.md) is the
   durable-record format; this skill has no replacement project template.
3. Run `scripts/project_report.py PROJECT.json` and inspect its JSON output.
4. Check whether the objective, status, overdue flags, and next actions are
   still accurate. Read linked research briefs when a risk, milestone, or
   decision depends on external evidence; the brief is supporting evidence, not
   a substitute for the project record.
5. Recommend one next action or an explicit pause. If progress is blocked by a
   material factual gap, hand off to [Deep Research](openlia://skills/deep-research)
   with a bounded question before comparing options. If progress is blocked by
   a meaningful choice, hand off to [Decision Analysis](openlia://skills/decision-analysis)
   instead of silently converting the unresolved choice into a task. Edit only
   when the current request or `assistant-policy.yaml` delegates `update_records`
   for the target domain; otherwise ask before editing records.

The helper calculates milestone completion only from explicit statuses and
sorts open tasks by priority, due value, and title. It does not infer dates or
render the review report.

Return a concise review containing the objective, status, completion signal,
open tasks, overdue items, risk and decision counts, linked evidence gaps, and
one recommended next action or explicit pause. Do not present this review as a
replacement project record.

## Pitfalls

- Percentage complete is a signal, not proof of outcome.
- Do not treat a linked research brief as current without checking its freshness
  requirement, evidence gaps, and next-check trigger.
- Do not hide risks or convert an unresolved decision into a task silently.
- Never close, delete, or re-scope a project unless the current request or
  policy explicitly authorizes that operation; deletion still follows the
  destructive-action policy.

## Verification

Confirm the objective is present, open tasks are listed, and the input project
record remains unchanged.
