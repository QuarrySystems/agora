# Agora Documentation Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up an Astro Starlight documentation site under `docs-site/` that restructures agora's existing prose docs into a Diátaxis-organized, audience-routed public site, plus three net-new pages, deployed via GitHub Pages.

**Architecture:** A new non-published `docs-site/` Astro Starlight project at the repo root. Content (Markdown/MDX) lives in `docs-site/src/content/docs/` under four Diátaxis folders (`tutorials/`, `how-to/`, `reference/`, `explanation/`). Existing `docs/*.md` guides and `docs/decisions/*` ADRs are moved into that tree and reframed; their relative links are rewritten to Starlight route links. A landing page sells offload and routes four personas. Build-time link validation (`starlight-links-validator`) is the test harness; broken internal links fail the build. A GitHub Actions workflow builds and deploys to Pages on merge to `main`.

**Tech Stack:** Astro + `@astrojs/starlight`, `astro-mermaid` (Mermaid rendering), `starlight-links-validator` (build-time link check), Pagefind (Starlight built-in search), pnpm workspace, GitHub Actions + GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-06-01-agora-docs-site-design.md`

---

## File structure

Created:
- `docs-site/package.json`, `docs-site/astro.config.mjs`, `docs-site/tsconfig.json` — Starlight project (private, name `@agora/docs-site`, NOT `@quarry-systems/*`).
- `docs-site/src/content/docs/index.mdx` — landing page (hero + router).
- `docs-site/src/content/docs/{tutorials,how-to,reference,explanation}/*.md(x)` — content tree.
- `docs-site/src/assets/` — logo/diagram assets if needed.
- `.github/workflows/docs.yml` — build + deploy to GitHub Pages.

Moved (and reframed):
- `docs/getting-started.md`, `docs/capability-recipes.md`, `docs/sync-providers.md`, `docs/needs-input.md`, `docs/remote-dispatch-windows.md`, `docs/dispatch-lifecycle.md`, `docs/offload-orchestration.md`, `docs/architecture-overview.md`, `docs/sandboxing-ai-agents.md`, `docs/writing-a-provider.md` → into the content tree.
- `docs/decisions/*.md` → `docs-site/src/content/docs/explanation/decisions/`.

Modified:
- `pnpm-workspace.yaml` — add `docs-site` to the `packages:` globs.
- `README.md` — repoint "User guides" / "Documentation" sections at the published site.

Unchanged:
- `docs/superpowers/specs/**` (internal design canon — linked-to, not published).
- All `packages/**` and `examples/**`.

---

### Task 1: Scaffold the Starlight project

**Files:**
- Create: `docs-site/` (via Astro CLI)
- Modify: `pnpm-workspace.yaml`

- [ ] **Step 1: Scaffold Starlight into `docs-site/`**

Run from repo root:
```sh
pnpm create astro@latest docs-site -- --template starlight --no-install --no-git --skip-houston --typescript strict
```
This creates `docs-site/` with `package.json`, `astro.config.mjs`, `tsconfig.json`, and a sample `src/content/docs/` tree.

- [ ] **Step 2: Rename the package and mark it private**

Edit `docs-site/package.json` so it is not mistaken for a published package:
```json
{
  "name": "@agora/docs-site",
  "private": true,
  "type": "module"
}
```
Keep the `scripts` block the scaffold generated (`dev`, `build`, `preview`, `astro`).

- [ ] **Step 3: Register `docs-site` in the pnpm workspace**

Edit `pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
  - 'examples/*'
  - 'docs-site'
```

- [ ] **Step 4: Install and smoke-build**

```sh
pnpm install
pnpm --filter @agora/docs-site build
```
Expected: install resolves Astro/Starlight; build succeeds and writes `docs-site/dist/`. (Build runs against the scaffold's sample content — that's fine for this task.)

- [ ] **Step 5: Confirm no published package gained an Astro dependency**

```sh
pnpm -r --filter "@quarry-systems/*" why astro 2>&1 | head -5
```
Expected: no `@quarry-systems/*` package depends on `astro` (the command reports nothing matched, or errors with "No projects matched the filters" if name pattern differs — either way, astro must not appear). This protects the agora-core dependency-allowlist invariant.

- [ ] **Step 6: Commit**

```sh
git add docs-site pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "docs(site): scaffold Astro Starlight project under docs-site/"
```

---

### Task 2: Configure the site — Diátaxis skeleton, sidebar, plugins, Pages base

**Files:**
- Modify: `docs-site/astro.config.mjs`
- Create: `docs-site/src/content/docs/{tutorials,how-to,reference,explanation,explanation/decisions}/.gitkeep`
- Modify: `docs-site/package.json` (new deps)

- [ ] **Step 1: Add Mermaid + link-validator dependencies**

```sh
pnpm --filter @agora/docs-site add astro-mermaid mermaid starlight-links-validator
```

- [ ] **Step 2: Create the four Diátaxis folders**

Create empty-tracked dirs so the structure exists before content lands:
```sh
mkdir docs-site/src/content/docs/tutorials docs-site/src/content/docs/how-to docs-site/src/content/docs/reference docs-site/src/content/docs/explanation docs-site/src/content/docs/explanation/decisions
```
Add a `.gitkeep` file to each of the five new directories.

- [ ] **Step 3: Write `astro.config.mjs`**

Replace `docs-site/astro.config.mjs` with:
```javascript
// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';
import starlightLinksValidator from 'starlight-links-validator';

// GitHub Pages project-site base path. If deploying to a custom domain or a
// user/org root site, set base to '/' and update `site` accordingly.
const SITE = 'https://quarrysystems.github.io';
const BASE = '/agora';

export default defineConfig({
  site: SITE,
  base: BASE,
  integrations: [
    mermaid({ theme: 'default' }),
    starlight({
      title: 'agora',
      description:
        'Secure, deterministic, auditable execution of AI agents — dispatch a DAG of tasks, fan out under file-locks, get back reviewable patches and a tamper-evident audit trail.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/quarrysystems/agora' },
      ],
      editLink: { baseUrl: 'https://github.com/quarrysystems/agora/edit/main/docs-site/' },
      lastUpdated: true,
      plugins: [
        // Strict link validation is enabled in Task 11 once all pages exist.
        // Seeded here in lenient mode so config is in place.
        starlightLinksValidator({ errorOnRelativeLinks: false, errorOnInvalidHashes: false }),
      ],
      sidebar: [
        {
          label: 'Tutorials',
          items: [
            { slug: 'tutorials/first-dispatch' },
            { slug: 'tutorials/first-offload-run' },
          ],
        },
        {
          label: 'How-to guides',
          items: [
            { slug: 'how-to/worker-file-layout' },
            { slug: 'how-to/sync-capabilities-subagents' },
            { slug: 'how-to/handle-needs-input' },
            { slug: 'how-to/remote-docker-dispatch' },
            { slug: 'how-to/deploy-fargate-s3' },
            { slug: 'how-to/verify-audit-bundle' },
            { slug: 'how-to/write-a-provider' },
          ],
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'reference' },
        },
        {
          label: 'Explanation',
          items: [
            { slug: 'explanation/architecture-overview' },
            { slug: 'explanation/sandboxing-ai-agents' },
            { slug: 'explanation/audit-guarantee-tiers' },
            { slug: 'explanation/privilege-boundary' },
            { slug: 'explanation/licensing-bsl' },
            { label: 'Decision records', autogenerate: { directory: 'explanation/decisions' } },
          ],
        },
      ],
    }),
  ],
});
```

- [ ] **Step 4: Build to verify config is valid**

```sh
pnpm --filter @agora/docs-site build
```
Expected: the build FAILS with errors that the configured `slug`s (e.g. `tutorials/first-dispatch`) have no matching content file. This confirms the sidebar config is wired and is the "failing test" for the content tasks that follow.

- [ ] **Step 5: Commit**

```sh
git add docs-site
git commit -m "docs(site): configure Diátaxis sidebar, Mermaid, link validation, Pages base"
```

---

### Task 3: Landing page — hero + audience router

**Files:**
- Create: `docs-site/src/content/docs/index.mdx`

- [ ] **Step 1: Write the landing page**

Create `docs-site/src/content/docs/index.mdx`. Use Starlight's splash template, hero, and CardGrid. The hero sells offload (the differentiator); the four cards route the personas from spec §2.

```mdx
---
title: agora
description: Secure, deterministic, auditable execution of AI agents.
template: splash
hero:
  tagline: Submit a DAG of agent tasks. Fan out safely under file-locks. Get back reviewable patches and a tamper-evident audit trail of exactly what ran.
  actions:
    - text: Orchestrate a DAG
      link: /agora/tutorials/first-offload-run/
      icon: right-arrow
    - text: View on GitHub
      link: https://github.com/quarrysystems/agora
      variant: minimal
      icon: external
---

import { Card, CardGrid } from '@astrojs/starlight/components';

## What do you want to do?

<CardGrid>
  <Card title="Dispatch one agent" icon="rocket">
    Wire `AgoraClient` into your app: register a capability, a subagent, and an env, then dispatch and read the result.
    [Start the dispatch tutorial →](/agora/tutorials/first-dispatch/)
  </Card>
  <Card title="Orchestrate a DAG" icon="puzzle">
    Run agent tasks unattended with `agora orch`: dependency ordering, parallel file-locks, reviewable patches, a verifiable audit bundle.
    [Run your first offload →](/agora/tutorials/first-offload-run/)
  </Card>
  <Card title="Extend a provider" icon="setting">
    Plug in a new compute, storage, credential, or result-sink backend behind agora's seams.
    [Write a provider →](/agora/how-to/write-a-provider/)
  </Card>
  <Card title="Evaluate / is it safe?" icon="approve-check">
    What agora is, how agents are sandboxed, the privilege boundary, and what the BSL license means for you.
    [Read the architecture →](/agora/explanation/architecture-overview/)
  </Card>
</CardGrid>
```

- [ ] **Step 2: Build**

```sh
pnpm --filter @agora/docs-site build
```
Expected: still fails on missing content slugs (Task 2 Step 4), but `index.mdx` itself produces no parse/MDX error. If the error list no longer mentions `index`, the landing page is valid.

- [ ] **Step 3: Commit**

```sh
git add docs-site/src/content/docs/index.mdx
git commit -m "docs(site): landing page with offload hero and four-persona router"
```

---

### Task 4: Port the two tutorials

**Files:**
- Create: `docs-site/src/content/docs/tutorials/first-dispatch.md` (from `docs/getting-started.md` + `examples/hello-world/`)
- Create: `docs-site/src/content/docs/tutorials/first-offload-run.md` (from `examples/offload-fanout/` + `docs/offload-orchestration.md`)
- Delete: `docs/getting-started.md` (content relocated)

- [ ] **Step 1: Create `first-dispatch.md`**

Add Starlight frontmatter, then port `docs/getting-started.md` reframed in **tutorial voice** (one happy path, no decision points, every command in order from a clean clone to a printed result). Add a Starlight `<Steps>` wrapper around the numbered build/configure/dispatch sequence.

Frontmatter:
```md
---
title: Your first dispatch
description: From a clean clone to one successful agent dispatch on local Docker.
---
import { Steps } from '@astrojs/starlight/components';
```
Body: port the §1–§5 runbook content of `getting-started.md` verbatim where accurate, converting "If you'd rather read the design first…" asides into a single "Next steps" link block at the end pointing to `/agora/explanation/architecture-overview/` and `/agora/tutorials/first-offload-run/`. Keep the worker-image build, `agora.config.mjs`, and dispatch commands exactly as in the source.

- [ ] **Step 2: Create `first-offload-run.md`**

Port the *tutorial-shaped* parts of `docs/offload-orchestration.md` (the `examples/offload-fanout/` walkthrough): build a 3-task plan, `agora orch serve`, `submit plan.json`, `watch <run-id>`, see the patches, `audit <run-id>`. Deep conceptual/reference material (queues/locks internals, guarantee tiers) is NOT duplicated here — link to `/agora/reference/cli/`, `/agora/reference/plan-json/`, and `/agora/explanation/audit-guarantee-tiers/`. Frontmatter:
```md
---
title: Your first offload run
description: Submit a three-task DAG, watch it fan out under file-locks, and verify the audit bundle.
---
```
End with a "Next steps" block linking the audit how-to and the guarantee-tiers explanation.

- [ ] **Step 3: Remove the relocated source file**

```sh
git rm docs/getting-started.md
```

- [ ] **Step 4: Build**

```sh
pnpm --filter @agora/docs-site build
```
Expected: the two `tutorials/*` slug errors from Task 2 are gone. Remaining errors are only for not-yet-created how-to/reference/explanation pages.

- [ ] **Step 5: Commit**

```sh
git add docs-site/src/content/docs/tutorials docs/getting-started.md
git commit -m "docs(site): port tutorials (first dispatch, first offload run)"
```

---

### Task 5: Port the five existing how-to guides

**Files:**
- Create: `docs-site/src/content/docs/how-to/worker-file-layout.md` ← `docs/capability-recipes.md`
- Create: `docs-site/src/content/docs/how-to/sync-capabilities-subagents.md` ← `docs/sync-providers.md`
- Create: `docs-site/src/content/docs/how-to/handle-needs-input.md` ← `docs/needs-input.md`
- Create: `docs-site/src/content/docs/how-to/remote-docker-dispatch.md` ← `docs/remote-dispatch-windows.md`
- Create: `docs-site/src/content/docs/how-to/write-a-provider.md` ← `docs/writing-a-provider.md`
- Delete: the five source files above.

- [ ] **Step 1: Port each file with frontmatter + link rewrites**

For each, prepend Starlight frontmatter and rewrite inter-doc relative links to Starlight routes:

| New file | title | description |
|---|---|---|
| `worker-file-layout.md` | Put files where the worker finds them | Where capability files land in the workspace, and the `agora-setup.sh` single-slot rule. |
| `sync-capabilities-subagents.md` | Sync capabilities & subagents | Use `agora capabilities sync` / `agora subagent sync`; the `claude-code` and `stoa` providers. |
| `handle-needs-input.md` | Handle a needs_input pause | How a subagent pauses for clarification and how re-dispatch threads `partial_state`. |
| `remote-docker-dispatch.md` | Dispatch to a remote Docker daemon | Orchestrate from one machine, run workers on another's Docker daemon over SSH. |
| `write-a-provider.md` | Write a provider | Implement a compute, storage, credential, or result-sink seam. |

Link rewrites (apply to every ported file):
- `](./sync-providers.md)` → `](/agora/how-to/sync-capabilities-subagents/)`
- `](./capability-recipes.md)` → `](/agora/how-to/worker-file-layout/)`
- `](./remote-dispatch-windows.md)` → `](/agora/how-to/remote-docker-dispatch/)`
- `](../examples/...)` → `](https://github.com/quarrysystems/agora/tree/main/examples/...)` (examples are not part of the site; link to the repo).

Note the title change for `remote-docker-dispatch.md`: drop the Windows-specific framing in headings; SSH remote dispatch is not Windows-only. Keep any Windows-specific notes as a callout, not the title.

- [ ] **Step 2: Remove relocated source files**

```sh
git rm docs/capability-recipes.md docs/sync-providers.md docs/needs-input.md docs/remote-dispatch-windows.md docs/writing-a-provider.md
```

- [ ] **Step 3: Build**

```sh
pnpm --filter @agora/docs-site build
```
Expected: the five corresponding `how-to/*` slug errors are gone (the two NEW how-to slugs `deploy-fargate-s3` and `verify-audit-bundle` still error — created in Tasks 8–9).

- [ ] **Step 4: Commit**

```sh
git add docs-site/src/content/docs/how-to docs/
git commit -m "docs(site): port five existing how-to guides with link rewrites"
```

---

### Task 6: Port the reference section

**Files:**
- Create: `docs-site/src/content/docs/reference/cli.md` (sidebar order via frontmatter)
- Create: `docs-site/src/content/docs/reference/mcp-tools.md`
- Create: `docs-site/src/content/docs/reference/agora-client-api.md`
- Create: `docs-site/src/content/docs/reference/config.md`
- Create: `docs-site/src/content/docs/reference/dispatch-lifecycle.md` ← `docs/dispatch-lifecycle.md`
- Create: `docs-site/src/content/docs/reference/plan-json.md`
- Create: `docs-site/src/content/docs/reference/package-map.md` ← README table
- Delete: `docs/dispatch-lifecycle.md`

Reference uses `autogenerate` (Task 2), so set `sidebar.order` in each file's frontmatter to control sequence.

- [ ] **Step 1: Create each reference page**

| File | title | order | Source / content |
|---|---|---|---|
| `cli.md` | CLI: `agora` & `agora orch` | 1 | Synthesize from `agora --help`, `agora orch --help`, and the offload guide's command list. Document every subcommand, flags, exit behavior. |
| `mcp-tools.md` | MCP tools | 2 | The six run-time tools exposed by `agora-mcp`; note `register`/`assign` are deliberately absent (link to privilege-boundary explanation). |
| `agora-client-api.md` | `AgoraClient` API | 3 | Constructor options + `capabilities`/`subagent`/`env`/`dispatch` surfaces from `packages/agora-client`. |
| `config.md` | `agora.config.{ts,js,mjs}` | 4 | Resolution order, every config key, worked `agora.config.mjs` from the examples. |
| `dispatch-lifecycle.md` | Dispatch lifecycle events | 5 | Port `docs/dispatch-lifecycle.md` verbatim (already reference-shaped); add frontmatter. |
| `plan-json.md` | `plan.json` schema | 6 | Every field (`tasks`, `depends_on`, `locks`, subagent/env/target bindings) from `examples/offload-fanout/plan.json` + orchestrator spec. |
| `package-map.md` | Package map | 7 | The 13-package table from the README "What's in this repo" section, plus the Mermaid dependency graph (renders via `astro-mermaid`). |

Each gets frontmatter, e.g.:
```md
---
title: CLI reference
description: Every `agora` and `agora orch` subcommand, flag, and exit behavior.
sidebar:
  order: 1
---
```

- [ ] **Step 2: Remove relocated source**

```sh
git rm docs/dispatch-lifecycle.md
```

- [ ] **Step 3: Build**

```sh
pnpm --filter @agora/docs-site build
```
Expected: reference autogenerate populates; no MDX errors. Mermaid graph in `package-map.md` renders without error.

- [ ] **Step 4: Commit**

```sh
git add docs-site/src/content/docs/reference docs/dispatch-lifecycle.md
git commit -m "docs(site): port reference section (CLI, MCP, API, config, lifecycle, plan.json, packages)"
```

---

### Task 7: Port explanation pages + ADR collection

**Files:**
- Create: `docs-site/src/content/docs/explanation/architecture-overview.md` ← `docs/architecture-overview.md`
- Create: `docs-site/src/content/docs/explanation/sandboxing-ai-agents.md` ← `docs/sandboxing-ai-agents.md`
- Create: `docs-site/src/content/docs/explanation/privilege-boundary.md` ← ADR-0005 + spec §10.6
- Create: `docs-site/src/content/docs/explanation/licensing-bsl.md` ← `LICENSING.md` + ADR-0017
- Move: `docs/decisions/*.md` → `docs-site/src/content/docs/explanation/decisions/`
- Delete: `docs/architecture-overview.md`, `docs/sandboxing-ai-agents.md`

- [ ] **Step 1: Port the four narrative explanation pages**

Add frontmatter + rewrite links for:
- `architecture-overview.md` — port verbatim; the Mermaid/ASCII flow diagram renders via `astro-mermaid`. title "Architecture overview".
- `sandboxing-ai-agents.md` — port verbatim. title "Sandboxing AI agents".
- `privilege-boundary.md` — NEW short page summarizing ADR-0005 and spec §10.6 (why `register`/`assign` never reach the AI loop); link to the ADR and to `reference/mcp-tools`. title "The privilege boundary".
- `licensing-bsl.md` — port `LICENSING.md` prose + ADR-0017 rationale into a reader-facing "what BSL means for you" page. title "Licensing & BSL".

- [ ] **Step 2: Move the ADRs into the content tree**

```sh
git mv docs/decisions/0001-package-scope.md docs-site/src/content/docs/explanation/decisions/0001-package-scope.md
```
Repeat for all 17 ADRs (`0001`–`0017`) and `docs/decisions/README.md` → `docs-site/src/content/docs/explanation/decisions/index.md`. Add minimal Starlight frontmatter (`title`, `description`) to the top of each moved ADR; ADRs already have an H1 title to reuse.

- [ ] **Step 3: Remove relocated narrative sources**

```sh
git rm docs/architecture-overview.md docs/sandboxing-ai-agents.md
```

- [ ] **Step 4: Build**

```sh
pnpm --filter @agora/docs-site build
```
Expected: explanation slugs resolve; ADR `autogenerate` lists all 17 under "Decision records". The remaining slug errors are only `explanation/audit-guarantee-tiers` (Task 10) and the two NEW how-to pages (Tasks 8–9).

- [ ] **Step 5: Commit**

```sh
git add docs-site/src/content/docs/explanation docs/
git commit -m "docs(site): port explanation pages and relocate the 17 ADRs"
```

---

### Task 8: New how-to — Deploy to Fargate + S3

**Files:**
- Create: `docs-site/src/content/docs/how-to/deploy-fargate-s3.md`

- [ ] **Step 1: Write the page**

Net-new how-to (task voice, numbered steps) covering the production target: swap `LocalDockerProvider`→`FargateProvider`, `LocalStorageProvider`→`S3StorageProvider`, `NoopCredentialProvider`→`AwsCredentialProvider`; pin the worker image to a digest (no `allowUnpinnedImage`); the S3 bucket + Object Lock setup that backs the external-immutable audit tier. Pull exact provider names and constructor options from `packages/agora-providers-fargate`, `packages/agora-storage-s3`, `packages/agora-providers-aws-creds`, and the MVP/offload specs' Fargate sections. Frontmatter:
```md
---
title: Deploy to Fargate + S3 (production)
description: Move from the local Docker stack to the production target — Fargate compute, S3 storage with Object Lock, AWS credentials.
---
```
Structure: Prerequisites → 1. Publish a pinned worker image → 2. Provision S3 (with Object Lock for the immutable audit tier) → 3. Swap providers in `agora.config` → 4. Set the Fargate target → 5. Dispatch and verify. End with a "Next steps" link to the audit how-to.

- [ ] **Step 2: Build**

```sh
pnpm --filter @agora/docs-site build
```
Expected: `how-to/deploy-fargate-s3` slug error from Task 2 is gone.

- [ ] **Step 3: Commit**

```sh
git add docs-site/src/content/docs/how-to/deploy-fargate-s3.md
git commit -m "docs(site): new how-to — deploy to Fargate + S3"
```

---

### Task 9: New how-to — Export & verify an audit bundle

**Files:**
- Create: `docs-site/src/content/docs/how-to/verify-audit-bundle.md`

- [ ] **Step 1: Write the page**

Net-new how-to extracted and expanded from the audit section of `docs/offload-orchestration.md` and the offload V1 spec. Cover: run `agora orch audit <run-id>`, what the bundle contains, how it self-verifies, what "verified" vs "tamper detected" output looks like, and which guarantee tier you get (link to `explanation/audit-guarantee-tiers`). Frontmatter:
```md
---
title: Export & verify an audit bundle
description: Produce the exportable evidence bundle for a run, verify it, and read which guarantee tier it asserts.
---
```
Structure: 1. Run `audit` → 2. Read the verification result → 3. Interpret the guarantee tier → 4. Hand the bundle to a third party. End linking the guarantee-tiers explanation.

- [ ] **Step 2: Build**

```sh
pnpm --filter @agora/docs-site build
```
Expected: `how-to/verify-audit-bundle` slug error gone.

- [ ] **Step 3: Commit**

```sh
git add docs-site/src/content/docs/how-to/verify-audit-bundle.md
git commit -m "docs(site): new how-to — export & verify an audit bundle"
```

---

### Task 10: New explanation — Audit & guarantee tiers

**Files:**
- Create: `docs-site/src/content/docs/explanation/audit-guarantee-tiers.md`

- [ ] **Step 1: Write the page**

Net-new explanation (understanding voice) of the audit model: the chained/tamper-evident log, the difference between **tamper-detecting** (local default path) and **tamper-evident at the external-immutable tier** (S3 Object Lock), what each guarantees and does NOT guarantee, and the honesty constraints from the offload V1 spec. This is the conceptual home that the two audit how-tos and the offload tutorial link into. Frontmatter:
```md
---
title: Audit & guarantee tiers
description: How agora's audit trail works, and the difference between tamper-detecting and tamper-evident (external-immutable) guarantees.
---
```

- [ ] **Step 2: Build**

```sh
pnpm --filter @agora/docs-site build
```
Expected: ALL configured slugs now resolve — the build succeeds with zero missing-content errors.

- [ ] **Step 3: Commit**

```sh
git add docs-site/src/content/docs/explanation/audit-guarantee-tiers.md
git commit -m "docs(site): new explanation — audit & guarantee tiers"
```

---

### Task 11: Cross-link pass + enable strict link validation

**Files:**
- Modify: `docs-site/astro.config.mjs` (tighten `starlight-links-validator`)
- Modify: tutorial/how-to pages (add "Next steps" blocks where missing)

- [ ] **Step 1: Add connective "Next steps" blocks**

Per spec §3.1: every tutorial ends linking the relevant how-to + explanation; every how-to links its reference pages. Verify/add these blocks on all `tutorials/*` and `how-to/*` pages (most added during porting; fill gaps here).

- [ ] **Step 2: Enable strict link validation**

In `docs-site/astro.config.mjs`, tighten the plugin so broken internal links FAIL the build:
```javascript
plugins: [
  starlightLinksValidator({ errorOnRelativeLinks: true, errorOnInvalidHashes: true }),
],
```

- [ ] **Step 3: Build — this is the full link test**

```sh
pnpm --filter @agora/docs-site build
```
Expected: build PASSES with zero broken-link errors. If any relative `./foo.md`-style links survived the port, the validator names them here — fix each by converting to a Starlight route link (`/agora/<section>/<slug>/`), then rebuild until green.

- [ ] **Step 4: Commit**

```sh
git add docs-site
git commit -m "docs(site): cross-link tutorials/how-tos and enable strict link validation"
```

---

### Task 12: GitHub Pages deploy workflow

**Files:**
- Create: `.github/workflows/docs.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/docs.yml`:
```yaml
name: Deploy docs site

on:
  push:
    branches: [main]
    paths:
      - 'docs-site/**'
      - 'docs/**'
      - '.github/workflows/docs.yml'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @agora/docs-site build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs-site/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Validate workflow YAML locally**

```sh
pnpm dlx @action-validator/cli .github/workflows/docs.yml || npx --yes yaml-lint .github/workflows/docs.yml
```
Expected: no YAML/schema errors. (If neither validator is available offline, confirm the file parses by eye against the snippet above.)

- [ ] **Step 3: Note the one-time manual step**

Add a comment at the top of `docs.yml`:
```yaml
# One-time: in the repo's Settings → Pages, set Source = "GitHub Actions".
# This cannot be done from a workflow file; a maintainer must enable it once.
```

- [ ] **Step 4: Commit**

```sh
git add .github/workflows/docs.yml
git commit -m "docs(site): GitHub Pages build-and-deploy workflow"
```

---

### Task 13: Repoint the README and clean up `docs/`

**Files:**
- Modify: `README.md` (the "User guides" and "Documentation" sections)
- Verify: `docs/` now contains only `decisions/` (moved out in Task 7 → should be empty) and `superpowers/`

- [ ] **Step 1: Repoint README doc links to the published site**

In `README.md`, replace the relative `docs/*.md` links in the "User guides" and "Documentation" sections with site URLs (`https://quarrysystems.github.io/agora/<section>/<slug>/`), and add a top-line "📖 Docs: https://quarrysystems.github.io/agora" pointer near the intro. Keep links to `docs/superpowers/specs/*` (internal canon) and `examples/*` as repo-relative.

- [ ] **Step 2: Confirm the old `docs/` guide files are gone**

```sh
ls docs/
```
Expected: only `superpowers/` remains (all 10 guides moved/deleted in Tasks 4–7; `decisions/` moved in Task 7). If any stray guide remains, it was missed — port or remove it.

- [ ] **Step 3: Full repo sanity build + existing checks**

```sh
pnpm --filter @agora/docs-site build
pnpm -r run lint
```
Expected: site builds; the existing package lint/dependency-allowlist checks stay green (docs-site is excluded from `@quarry-systems/*` checks by name).

- [ ] **Step 4: Commit**

```sh
git add README.md docs/
git commit -m "docs(site): repoint README at the published docs site"
```

---

## Self-review notes

- **Spec coverage:** site scaffold (T1), Starlight+Diátaxis+router (T2–T3), all PORT pages (T4–T7), the three NEW pages — Fargate+S3 (T8), verify-audit (T9), guarantee-tiers (T10) — cross-linking (T11), deploy (T12), README repoint (T13). Success criteria §8: self-serve path (T3+T4 links), one-mode-per-page (enforced by Diátaxis folder placement), offload-first hero (T3), CI build+deploy (T12), no Astro leak into published packages (T1 Step 5, T13 Step 3). All spec sections map to a task.
- **Deferred per spec §7:** TypeDoc API generation, doc versioning, Algolia, i18n, publishing the design specs — none appear as tasks. Correct.
- **Open questions (spec §9) resolved here:** content lives directly in `docs-site/src/content/docs/` (no symlink — avoids Windows friction); ADRs render via `autogenerate` directory (one entry each under a "Decision records" group); hosting = GitHub Pages.
- **Naming consistency:** package `@agora/docs-site` and slug paths (`tutorials/first-dispatch`, `how-to/worker-file-layout`, etc.) are identical between the sidebar config (T2), the content filenames (T4–T10), and the cross-links (T3, T11).
