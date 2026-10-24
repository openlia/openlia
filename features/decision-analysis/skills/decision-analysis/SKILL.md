---
name: decision-analysis
description: Compare options with explicit criteria and trade-offs.
version: 0.1.0
platforms: [macos, linux]
required_environment_variables: []
required_credential_files: []
workspace_domains:
  - decisions
metadata:
  hermes:
    tags: [personal-os, decisions, analysis]
    category: reasoning
---

# Decision Analysis

## When to Use

Use when a meaningful choice has multiple viable options, constraints, and
explicit trade-offs. Typical examples include choosing a project approach,
comparing a purchase, evaluating a job or housing option, or deciding whether
to continue, pause, or change direction.

Do not use this workflow for routine prioritization when the daily briefing's
important-urgent matrix is sufficient. Do not score options that already fail a
hard constraint; remove them or mark them infeasible before building the
matrix.

## Daily Workflow Handoffs

- **Inbox triage:** capture a choice as a proposed decision when the source
  contains a question, competing options, or a trade-off. Do not turn one
  option into a task merely because it was mentioned.
- **Daily briefing:** use a surfaced proposed decision to choose what needs
  attention today. The briefing does not score options automatically.
- **Project review:** use this workflow when an unresolved choice blocks a
  project. Keep the decision separate from any implementation task.
- **Weekly review:** revisit proposed decisions and decided records whose
  review date has arrived. Reopen analysis only when new evidence or changed
  priorities justify it.
- **Personal finance:** use current finance review and portfolio records as
  read-only context for affordability, liquidity, allocation, and risk
  constraints. Use [Deep Research](openlia://skills/deep-research) first when
  investment evidence is missing. A recommendation never authorizes a trade.

## Procedure

1. **Frame the choice.** State one specific question, the decision deadline,
   relevant goals, and hard constraints. Include the current approach, defer,
   or do-nothing option when it is genuinely available.
2. **Define the options.** Give each option a name, benefits, costs, risks, and
   known evidence. Ask for clarification instead of inventing an option or
   preference.
3. **Choose criteria.** Use a small set of decision-relevant criteria. Give
   each a positive weight from 0 to 10 and define what scores 0 and 10 mean.
   Score a positive criterion such as `affordability`, not a negatively
   oriented proxy such as `cost`, unless the score meaning makes the direction
   explicit.
4. **Gather evidence.** Read linked goals, projects, claims, and research that
   materially affect the choice. Use [Deep Research](openlia://skills/deep-research)
   first when important external evidence is missing. When consuming a research
   brief, use its claim status, source IDs, counterevidence, freshness, and
   evidence gaps; do not treat its source-usefulness matrix or provisional
   synthesis as a precise option score. Record evidence gaps; do not turn
   uncertain prose into precise scores.
5. **Build and run the matrix.** Put the question, criteria, options, scores,
   and risks in the JSON shape accepted by `scripts/score_options.py`, then run
   the helper with an explicit input path. The helper returns JSON only; inspect
   the complete output, not just the ranking, and let this skill interpret it.
6. **Interpret uncertainty.** A clear recommendation requires complete scores
   and one unique leader. A tie has no automatic winner. A matrix with missing
   scores is provisional; missing values are displayed and treated as zero for
   calculation, not as evidence that the option is poor. Review qualitative
   risks and constraints separately.
7. **Check sensitivity.** Rerun the matrix with reasonable alternative weights
   for the most important criteria. State what change would alter the
   recommendation and whether the decision is robust.
8. **Separate recommendation from decision.** Explain the leading option,
   trade-offs, evidence gaps, and risks. The person makes the decision. A
   ranking never authorizes spending, messaging, scheduling, trading, or other
   external action.
9. **Record and implement.** Before writing, read `workspace.yaml` and
   `assistant-policy.yaml`. Resolve the registered `decisions` domain and read
   its configured template and the schema referenced by that template. Use the
   workspace [Decision Template](openlia://workspace/decisions/decision-template.md)
   as the only durable-record format; do not use a skill-local replacement.
   Preserve source links, keep the record `proposed` until the person chooses,
   and follow the active write authority. After the choice, set `status: decided`,
   record the decision date, link the resulting tasks or project update, and set
   a review date when useful.
10. **Review the outcome.** At the review date, record what happened, which
     assumptions held, and whether the decision should be continued, revised,
     superseded, or abandoned.

### Input Shape

Use one criterion object per criterion and one option object per option:

```json
{
  "question": "Which approach should we use for the launch?",
  "criteria": [
    {
      "name": "fit",
      "weight": 8,
      "score_meaning": "0 = poor fit for the goal; 10 = excellent fit"
    },
    {
      "name": "affordability",
      "weight": 5,
      "score_meaning": "0 = unaffordable; 10 = comfortably affordable"
    }
  ],
  "options": [
    {
      "name": "Option A",
      "scores": {"fit": 8, "affordability": 6},
      "risks": ["Requires an unfamiliar tool"]
    }
  ]
}
```

### Chat-Only Output

When no workspace write is requested or authorized, return the analysis without
creating a record. Include the question, constraints, options, criteria and
score meanings, ranking status, risks, evidence gaps, sensitivity result,
recommendation, and the fact that the person still makes the decision. If the
registered workspace has no usable `decisions` template or schema, report that
missing configuration instead of falling back to a skill-owned template.

## Pitfalls

- Do not manufacture scores, weights, evidence, or preferences from vague
  prose.
- Do not optimize a proxy criterion while ignoring hard constraints or
  qualitative risks.
- Do not call a tied or incomplete matrix a winner.
- Do not silently treat missing scores as low confidence evidence without
  disclosing the helper's zero-for-calculation behavior.
- Do not overwrite a prior decision record when a dated or versioned note can
  preserve the reasoning history.

## Verification

Confirm every criterion and its score meaning is visible, all options are
feasible or explicitly excluded, missing scores and evidence gaps are
disclosed, ties are identified, sensitivity has been considered, qualitative
risks have been reviewed, and the recommendation remains separate from the
person's decision.
