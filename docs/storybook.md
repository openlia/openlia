# Workspace UI Storybook

## Start reviewing

From the repository root:

```sh
bun install
bun run --cwd packages/workspace-ui storybook
```

Open **http://127.0.0.1:6006**. The server binds only to localhost and does not
start the application API. Use Node.js 22.12+ with Bun for the Storybook/Vite CLI.

- **Canvas** reviews one component/state; use it for dialogs.
- **Docs** gives the component/group description and source examples.
- **Controls** edits supported props; Calendar Month exposes its title, Timeline
  exposes title, initial zoom, grouping, and generic items.
- **Actions** records callbacks. Mock API mutations stay in memory.
- The **viewport toolbar** offers desktop (1440×1000) and mobile (390×844).
- **Accessibility** runs axe checks and surfaces existing findings. Findings are
  currently non-blocking (`test: "todo"`), not a claim of full accessibility.

The catalog currently contains 101 stories covering 68 named exported UI
components. Use the inventory command rather than this count as the ongoing
source of truth.

## Catalog

| Group | What to review |
| --- | --- |
| Foundations | Real theme, controls, badges, copy-link button |
| Calendar | Month overflow; Week overlaps; all-day/overnight spans; timezone/DST; Timeline zoom/grouping and generic items; editor/details; loading/error/empty states; real OpenUI three-tab composition |
| Charts | Reusable bar/line/pie panels, exact tables, signed changes, Sankey references/cycles/empty states, and long labels |
| OpenUI | All custom registered components, diagnostics/error boundary, dashboard composition, representative upstream primitives |
| Documents | Markdown/frontmatter, code editor, file navigator, document pane/inspector, loading/error/conflict, file/action dialogs |
| Chat | Header, transcript/tool results, Markdown, composer, navigation, full mock conversation |
| Skills | Navigator, detail/editor, creation dialog |
| Ingestion | Library, card, filters, inspector, upload, password profiles |
| Workspace | Header, activity/Git, checkpoint proposals, configuration, schedule, usage/pricing, maintainer/fix preview, migrations, projects, sharing |
| Compositions | Complete workspace against an isolated mock API |

Upstream OpenUI primitives have a representative gallery; the inventory covers
our exported components, not every third-party component or private helper.

Charts also include a full categorical palette and an interactive filter/reorder
example. Application and Storybook share categorical palette tokens. Pie and
Sankey identities remain stable across filters rather than following display order.

## Isolation and repeatability

Configuration lives in `packages/workspace-ui/.storybook/`. Its own Vite config
uses React and Tailwind only. It must **not** inherit the app's TanStack Start
plugin, router entry, or server-function runtime.

Stories import the actual app theme/chat styles and upstream OpenUI stylesheet.
The app currently has a dark theme; Storybook does not invent an unsupported
light theme. The preview freezes `Date` at **2026-10-27T09:00:00Z**, while timers
remain real. Fixtures contain no personal records or credentials.

`src/client/stories/fixtures.ts` creates a fresh mock `WorkspaceApi` per story.
Calendar occurrences are synthetic, and appointment saves mutate only that API.
Calendar source URLs and public-share downloads resolve to synthetic `data:`
content. There is no native Remind evaluation, real file write, external calendar
integration, invitation delivery, cron job, or published shared link.

The preview rejects live `/api/` and `/_server/` fetches and cross-origin fetches
before sending them. Browser smoke checks independently reject backend/external
requests. These guards are development safeguards, not a general browser sandbox;
do not put real credentials or user data into stories. Native browser navigation
and explicit external links are not intercepted by the fetch guard.

## Add or update a story

1. Add a `*.stories.tsx` file under `src/client/`; current stories are grouped in
   `src/client/stories/`.
2. Import the real component, not a visual clone. Use `Meta` / `StoryObj` from
   `@storybook/react-vite` for typed args and Controls.
3. Supply required providers and callbacks. Use `action()` / `fn()` for callbacks,
   `storyLoader` for async fixture data, and `CalendarFrame` for isolated calendar
   views. Never use `runtimeApi` or an implicit live API default.
4. Add `parameters.componentExports`, such as
   `"openui/calendar/CalendarMonth.tsx#CalendarMonthView"`, identifying the exported
   components the story actually renders. For OpenUI wrappers, render a program
   through the real `Renderer` and `openliaLibrary`.
5. Include useful empty, loading, failure, validation, and mobile states. For modal
   stories use `parameters.docs.story.inline: false` to avoid competing dialogs
   in the Docs page.
6. Put interactions in `play` using `expect`, `userEvent`, and `within` from
   `storybook/test`. Query native dialogs within `document.body`.
7. Run the commands below and inspect Canvas visually.

The inventory script uses TypeScript's AST to track named exported React
functions/classes and OpenUI `defineComponent` exports. It fails on missing or
stale story declarations. This is **declared catalog coverage**, not line coverage
or a guarantee that every component state has a story.

## Verification

```sh
bun run --cwd packages/workspace-ui storybook:coverage
bun run --cwd packages/workspace-ui typecheck:storybook
bun run --cwd packages/workspace-ui test:storybook
```

`test:storybook` builds `.storybook-static/`, serves it read-only on localhost
port **6007**, and visits every indexed story on desktop and mobile. It waits for
the render/play lifecycle, checks runtime errors and blocked requests, and
records failure artifacts under `.playwright/storybook/`. It uses Storybook's
test-runner user agent so assertions pause CSS animations, including DaisyUI's
scroll-driven modal animation. This does not disable animations in local review.
Playwright's browsers must be installed (`bunx playwright install chromium webkit`
from the package directory if missing).

The normal app build does not import stories. Static Storybook output is ignored
by Git and is not copied into the production workspace-ui image. Storybook smoke
checks supplement, rather than replace, Vitest, native Remind/server tests, and
real-backend browser acceptance tests.
