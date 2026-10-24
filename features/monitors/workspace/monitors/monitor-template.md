---
$schema: ./monitor-template.schema.json
status: null # active | paused | triggered | retired
source: null # source URL or other stable reference
check_frequency: null # hourly | daily | weekly | monthly
alert_channel: null # e.g. Telegram or Daily Briefing
---

# <Monitor Title>

## Target Condition
What specific condition, threshold, or event are we watching for?

## Trigger Rule
- [e.g. price <= threshold, new version released, keyword match]

## Recommended Action
- Recommended action:

## Check Log
- YYYY-MM-DD: Checked - [Result]
