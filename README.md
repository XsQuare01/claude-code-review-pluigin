# React Code Review Plugin

Modular code review workflows for **React** codebases, packaged as a Claude plugin.

This is not a general-purpose review system. Every rule module assumes the code under review is a React application; modules that need more than that (FSD, Electron, Tailwind, React Three Fiber) declare it in their own header and are skipped when the assumption does not hold.

## Install

Run these in Claude Code:

```
/plugin marketplace add XsQuare01/claude-code-review-pluigin
/plugin install react-code-review-plugin@react-code-review
/reload-plugins
```

Choose the **user** scope so the workflows are available in every project. The commands become `/code-review`, `/code-review-fast`, and the rest — no files are copied into the project or into `~/.claude`.

To develop against a local checkout instead, point the marketplace at the directory:

```
/plugin marketplace add /absolute/path/to/claude-code-review-pluigin
```

### Update and remove

```
/plugin marketplace update react-code-review
/reload-plugins
```

Then confirm the version changed:

```bash
claude plugin list      # expect the new Version:
```

**A version bump is what makes an update take effect.** Refreshing the marketplace on an unchanged version does nothing to the install, and reports success anyway. See [Versioning](#versioning).

To remove it:

```
/plugin uninstall react-code-review-plugin@react-code-review
```

> **Avoid `/plugin update` for this plugin.** In our testing it installed an unrelated plugin instead of updating this one — twice, both with no argument and with `react-code-review-plugin@react-code-review` named explicitly. Both times the output was `✓ Installed code-review`, and Anthropic's official `code-review` plugin appeared in the plugin list. The marketplace-refresh path above is what actually moved the install from 2.0.0 to 2.1.0, reporting `Updated 1 marketplace (1 plugin bumped)`.
>
> The `claude plugin update <plugin>@<marketplace>` CLI form exists but we have not tested it. If you use it, verify with `claude plugin list` afterwards.

### Versioning

The plugin sets an explicit `version` in `.claude-plugin/plugin.json`, and Claude Code uses that string as its **cache key**. An installed copy only updates when the version changes — pushing commits under the same version leaves every install stale, and every surface reports health: `claude plugin list` shows the expected version, `claude plugin details` lists all seven skills, and a marketplace refresh says it succeeded. Nothing surfaces the mismatch.

So **every change bumps the version** — documentation included.

| Part | When |
|------|------|
| PATCH (`2.2.0` → `2.2.1`) | **the default.** Fixes, wording, documentation, new or reworded rules inside an existing module, tuning an existing workflow |
| MINOR (`2.2.1` → `2.3.0`) | a new rule module file, or a workflow gaining a capability it did not have — a new command, a new flag |
| MAJOR | changes that invalidate existing rule IDs or past reports |

When unsure, use PATCH. The version here is a cache key and a change signal, not a compatibility contract — nothing resolves it as a dependency range, so an over-large bump communicates something that did not happen, while an extra patch number costs nothing.

`scripts/check-version-bump.mjs` enforces this in CI: any pull request whose diff is non-empty must change the version, or the check fails.

Deciding per-change whether something "really ships" is a judgment call, and a judgment call is where the exception that breaks the rule gets made. A spare patch number costs nothing; a stale install costs an hour of reviewing against the wrong rules.

`version` lives in `plugin.json` only. The marketplace entry deliberately omits it: `plugin.json` wins when both are set, so a second copy can only drift.

### Verify the install

**Is it installed and enabled?**

```bash
claude plugin list
```

Look for `react-code-review-plugin@react-code-review` with `Scope: user` and `Status: ✔ enabled`.

**Did every component load?**

```bash
claude plugin details react-code-review-plugin@react-code-review
```

Expect `Skills (7)` and `Agents (1)`. The command also prints the always-on token cost the plugin adds to each session.

**Is the installed copy current?** The two commands above cannot tell you this — a stale install still lists cleanly with all seven skills. Compare the installed commit against the source:

```bash
grep -o '"gitCommitSha": "[a-f0-9]*"' ~/.claude/plugins/installed_plugins.json
git -C /path/to/claude-code-review-pluigin rev-parse HEAD
```

**Are the rules self-consistent?**

```bash
node ~/.claude/plugins/cache/react-code-review/react-code-review-plugin/*/scripts/validate-rules.mjs
```

**Is a review actually using them?** Run `/code-review` once and check the rules directory the report cites (`workflow-contract.md` C-1). It must be the plugin path — `~/.claude/review-rules` means it fell through to the stale fallback.

> **Do not copy `skills/` and `review-rules/` into `~/.claude/`.** That was the old way to use this repo and it drifts: the copy stops receiving rule updates while still looking installed, and reviews quietly run against stale rules. It is also the trap the third fallback below creates. If a copy already exists at `~/.claude/skills/code-review*`, remove it after installing the plugin — see [Troubleshooting](#troubleshooting).

### Troubleshooting

**Two sets of `/code-review` commands appear, or a report cites rule IDs this repo does not have.**

An older manual copy under `~/.claude/` is installed alongside the plugin. Home skills load under their bare name while plugin skills are namespaced, so `/code-review` resolves to the copy and the plugin's commands sit behind the `react-code-review-plugin:` prefix — the copy wins the name you actually type. A copy predating the current inventory is worse than stale: under the old `00`–`12` numbering `03` meant state rules, where it now means React runtime rules, so its findings cannot be traced against current rule text at all.

Detect it — any output means the copy is present:

```bash
ls -d ~/.claude/skills/code-review* ~/.claude/review-rules 2>/dev/null
```

The plugin needs neither path. Remove them and reload:

```bash
rm -rf ~/.claude/skills/code-review* ~/.claude/review-rules
```

```
/reload-skills
```

Keep the copy only if it holds edits that were never pushed here — diff it against this repository before deleting.

Removing the copy does **not** hand the bare `/code-review` name to this plugin. Claude Code ships its own `code-review` skill, so that name resolves to the built-in review while this plugin's default pass is `react-code-review-plugin:code-review`. The other six commands — `code-review-full`, `-fast`, `-commit`, `-props`, `-math`, `-exception` — are unique to this plugin and work unprefixed. When a report's rules directory or heading looks wrong, check which of the two you invoked before suspecting the install.

**`EBUSY: resource busy or locked` when adding the marketplace.**

```
Error: Failed to finalize marketplace cache. Please manually delete the directory at
C:\Users\<you>\.claude\plugins\marketplaces\react-code-review if it exists and try again.

Technical details: EBUSY: resource busy or locked, rename
'...\marketplaces\XsQuare01-claude-code-review-pluigin' -> '...\marketplaces\react-code-review'
```

The marketplace is named `react-code-review` while the repository is named `claude-code-review-pluigin`, so `marketplace add` clones into a directory named after the repo and then renames it to the marketplace name. On Windows that rename fails while anything still holds the destination — a previous partial add, an editor, a file watcher, or an indexer. Delete the directory the error names and add it again:

```bash
rm -rf ~/.claude/plugins/marketplaces/react-code-review
```

```
/plugin marketplace add XsQuare01/claude-code-review-pluigin
/plugin install react-code-review-plugin@react-code-review
```

The install itself is unaffected by the failed rename — a marketplace that never finalized simply is not there, so nothing partial is left behind to clean up beyond that directory.

## React version support

The baseline is **React 18**. Rules that only hold on a newer version, or only under a particular rendering model, carry that condition in the rule text and are skipped when the condition is not met. The project's React version comes from `package.json`; when it cannot be determined, version-gated rules do not apply.

| Gate | Applies when | Rules |
|------|--------------|-------|
| React 18+ | baseline | everything not listed below |
| React 19+ | `react` >= 19 | `03-1` conditional `use`, `03-10` Actions / `useActionState` / `useFormStatus` / `useOptimistic`, ref-as-prop |
| React Compiler | compiler enabled in build config | `03-10`, `04-6`, `14-4` — no manual memoization is demanded or removed |
| SSR / SSG | server rendering in use | `03-8` hydration parity, `03-9` `getServerSnapshot` |
| RSC | `'use client'` / `'use server'` present, or an RSC framework configured | all of `21-rsc.md` |

A version-gated rule that fires on a project that cannot use the API is a false positive, not a suggestion to upgrade.

## Workflows

| Command | Scope |
|---------|-------|
| `/code-review` | Bounded default review — one consolidated pass over all numbered modules |
| `/code-review-fast` | Compressed single-agent review, at most one issue per file |
| `/code-review-commit` | Same modules, scoped to a single commit patch |
| `/code-review-full` | Exhaustive multi-pass: general (per-module) + props + math + exception |
| `/code-review-props` | Props drilling, handler tunneling, argument passing |
| `/code-review-math` | 3D transform / matrix logic (Three.js, R3F, WebGL) |
| `/code-review-exception` | Exception handling, propagation, fallback, recovery |

`/code-review` accepts `--module` to restrict the pass to specific rule modules. Tokens resolve against the module filenames at runtime — by number (`--module 01,02`), by slug (`--module fsd,type`), or by unambiguous slug prefix. An unknown or ambiguous token stops the review and lists the available modules rather than silently falling back to a full pass; modules that were filtered out are never reported as passing.

## Rule modules

Numbered modules (`review-rules/[0-9]*.md`) are loaded by the general review passes. The numbering is contiguous and doubles as execution order — **rule IDs always match the file prefix**.

| # | Module | Focus |
|---|--------|-------|
| 00 | `00-rule.md` | Common rules — scope, rule-ID convention, report output |
| 01 | `01-fsd.md` | FSD layers, public API, feature naming *(FSD only)* |
| 02 | `02-type.md` | Type safety, trust boundaries, assertions, tsconfig-aware judgment |
| 03 | `03-react-rules.md` | Hooks rules, render purity, key stability, derived state |
| 04 | `04-state.md` | Effects, cleanup, deps, async state, rerenders |
| 05 | `05-structure.md` | Function/component size, separation of concerns |
| 06 | `06-jsx.md` | Conditional rendering, list rendering, JSX readability |
| 07 | `07-naming.md` | Naming and comments |
| 08 | `08-constants.md` | Magic values, constant duplication and placement |
| 09 | `09-code-quality.md` | Imports, dead code, consistency, anti-patterns |
| 10 | `10-principles.md` | Development principles (SSOT, SRP, DRY, …) |
| 11 | `11-styling.md` | Tailwind + design tokens *(Tailwind only)* |
| 12 | `12-accessibility.md` | Semantics, keyboard, focus, labels, ARIA |
| 13 | `13-dx.md` | Discoverability, change safety, onboarding |
| 14 | `14-react-performance.md` | Virtualization, code splitting, input responsiveness |
| 15 | `15-performance.md` | Algorithmic complexity, data structures |
| 16 | `16-api-contract.md` | Contract compatibility, schema/mapper alignment, query keys |
| 17 | `17-concurrency.md` | Duplicate submits, race/order, cancellation, idempotency |
| 18 | `18-dangerous-change.md` | Auth, destructive data changes, payments, secrets |
| 19 | `19-intent.md` | Problem framing, trade-offs, justification |
| 20 | `20-deletion-regression.md` | Deletion regression checks |
| 21 | `21-rsc.md` | Server/client boundary, Server Functions, serialization *(RSC only)* |

Non-numbered files are excluded from the automatic scan:

- `fast.md` — compressed ruleset for `/code-review-fast`
- `props.md` — `P-x` rules for `/code-review-props`
- `math.md` — `A-x` / `C-x` rules for `/code-review-math`
- `exception.md` — `EX-x` rules for `/code-review-exception`
- `workflow-contract.md` — shared execution contract (not a rule module)
- `catalog.json` — applicability metadata (not a rule module)

## Shared workflow contract

`review-rules/workflow-contract.md` holds the procedure every workflow shares: rules-directory resolution, module discovery, applicability gating, diff range, excluded paths, execution safety, report naming, and honest failure reporting. Each skill references it and declares only what differs in its own mode — scope, module set, fan-out strategy, output density.

The contract exists because the alternative had already failed: the same procedure copied into seven skill documents drifted apart, and workflows started behaving differently for the same request.

## Applicability metadata

`review-rules/catalog.json` records **when** a module applies — required profile (FSD, Tailwind, RSC, Electron, TanStack Query, server code, contract provider), minimum React version, which workflows load it, and which individual rules carry a narrower gate than their module. The Markdown modules stay canonical for **what** a rule says; the catalog never generates documentation and never restates rule text.

A module whose profile does not hold is reported as `SKIPPED` with a reason. It is never silently dropped and never counted as passing — a rule that was not run and a rule that found nothing are different outcomes.

Each profile carries the **signals that establish it** in `profiles[].detect`, so a skip rests on something found rather than on an impression about the stack. A signal is a dependency, a file glob, a string with a search scope, a set of directories with a minimum match count, or another profile that implies this one; signals combine under `any` / `all`. The matched signal is recorded in the report (`workflow-contract.md` C-3), which is what makes a skip auditable.

Two properties of that list are load-bearing:

- **A missed profile costs as much as a false positive.** A module skipped because its signal never matched reads exactly like a module that found nothing. Where a plausible-looking check would produce that outcome, the profile records it in `cautions` — `tailwind` exists because a `tailwind.config` check skips styling review on every Tailwind 4 project, which configures through CSS and ships no config file.
- **What cannot be detected says so.** `contract-provider` sets `detect: "declared"`: whether anything outside this repository consumes a contract is a fact about the outside world. It comes from the user or project config, never from inference, and its `hints` justify asking rather than concluding.

`scripts/validate-rules.mjs` enforces the shape — a profile with no `detect`, a mistyped signal key, a `content` signal with no search scope, a `dirs` signal with no threshold, a reference to an undefined profile, a reference cycle, or a profile no module requires all fail the `catalog` check.

## Rule IDs

Every finding carries an ID that matches its source file, so a report can always be traced back to the rule text.

| Module kind | Format | Example |
|-------------|--------|---------|
| Numbered | `{file}-{rule}` | `03-1`, `16-2`, `20-4` |
| Principles | `10-{abbrev}` | `10-SSOT` |
| Exception | `EX-{n}` | `EX-3` |
| Props | `P-{n}` | `P-5` |
| Math | `A-{n}` / `C-{n}` | `A-2`, `C-5` |

## Report output

Reports are written to `./review-reports/code-review-{workflow-name}-{branch-name}-{date}.md`, where `workflow-name` is one of `default`, `full`, `fast`, `commit`, `props`, `math`, `exception`. An existing report never counts as a completed review — each run performs a fresh review and writes a new file.

## Execution safety

Every workflow is **read-only by default** (`review-rules/00-rule.md` 00-9). Reviews run lint, typecheck, and tests without mutating flags; auto-fix (`lint:fix`, `--fix`, `--write`) and code changes happen only when the user explicitly asks. Tool output is reported in its own section, separate from review findings, so what a tool caught is never confused with what the reviewer judged.

If the user asks for a read-only review, says not to modify files, or wants a text-only answer, that request outranks every other rule — including report generation. No file is written and the result is returned in the response.

## Rule directory resolution

Skills resolve the rules directory in this order and use the first that exists:

1. `${CLAUDE_PLUGIN_ROOT}/review-rules/` — installed as a plugin
2. `./review-rules/` — vendored into the repository
3. `~/.claude/review-rules/` — copied into the home configuration

Skills never hardcode the module list; they enumerate the directory at runtime, so adding or removing a module requires no skill changes.

The third entry is a fallback for older setups, and it is the one that bites: if the plugin fails to resolve, a stale `~/.claude/review-rules/` silently takes over and the review runs against whatever rules were copied there months ago. The resolved path is reported with every review (`workflow-contract.md` C-1) precisely so this is visible rather than assumed. If you have no reason to keep that directory, delete it.

## Included agent

`agents/correctness-reviewer.md` is an optional evidence-first correctness reviewer (does the implementation match the PR's stated intent across all branches?). It is not part of the default workflows — invoke it explicitly when you want a correctness pass alongside the rule-based review.

## Directory structure

```text
claude-code-review-plugin/
├── .claude-plugin/plugin.json
├── .github/workflows/validate.yml
├── LICENSE
├── scripts/validate-rules.mjs
├── tests/workflow-fixtures.md
├── agents/correctness-reviewer.md
├── skills/
│   ├── code-review/SKILL.md
│   ├── code-review-fast/SKILL.md
│   ├── code-review-commit/SKILL.md
│   ├── code-review-full/SKILL.md
│   ├── code-review-props/SKILL.md
│   ├── code-review-math/SKILL.md
│   └── code-review-exception/SKILL.md
├── review-rules/
│   ├── 00-rule.md … 21-rsc.md
│   ├── workflow-contract.md
│   ├── catalog.json
│   ├── fast.md
│   ├── props.md
│   ├── math.md
│   └── exception.md
└── README.md
```

`skills/` and `review-rules/` must stay together. Do not copy the skill files without the rules.

## Validation

```bash
node scripts/validate-rules.mjs
```

No dependencies, no install step. CI runs it on every pull request and a failure blocks the merge.

It checks the properties this repo promises but cannot hold by hand:

| Check | What it catches |
|-------|-----------------|
| `inventory` | gaps or duplicates in module numbering |
| `rule-id` | a heading whose ID disagrees with its file prefix; duplicate IDs |
| `cross-ref` | a reference to a module file or rule ID that does not exist |
| `readme` | README inventory out of step with the actual files |
| `skill` | a skill that does not defer to the contract, declares an unregistered `workflow-name`, or points at a missing rule document |
| `fast-sync` | a missing digest section, a conditional rule whose severity or applicability was lost in compression, a stale module range |
| `hardcoded-path` | `~/.claude/review-rules` re-introduced into a skill instead of using the resolution order |
| `catalog` | a module with no catalog entry, an entry pointing at a missing file, an undefined profile, a profile with no detection signal, a mistyped or incomplete signal, a profile reference cycle, a profile no module requires |
| `manifest` | missing manifest fields, plugin/marketplace disagreement, skill frontmatter without name or description |
| `fixtures` | a contract clause with no scenario in `tests/workflow-fixtures.md` |

**What it does not check.** Whether a workflow actually behaves as the contract says. A review workflow is prose executed by a language model, so its behaviour can only be observed by running a review. `tests/workflow-fixtures.md` lists those scenarios with expected outcomes for manual runs; the validator keeps that checklist in step with the contract but cannot execute it.

## Maintenance notes

- Adding a numbered module: **append the next free number — never renumber existing modules.** Rule IDs are quoted in review reports and in this repo's own cross-references, so renumbering silently invalidates every past report and breaks traceability, which is the one property the ID convention exists to provide. Grouping by topic is a readability preference; stable IDs are a correctness property, and the latter wins. Add the module to the README inventory and to the matching section of `fast.md` in the same change.
- `fast.md` is a hand-maintained compression of the numbered modules. Three things must match the source exactly: **severity**, **applicability conditions**, and **exception clauses**. Lowering a severity changes the verdict, dropping a trigger widens the scope, and dropping an exception turns a rule into a false positive.
- Project-specific assumptions belong in each module's header, not in this README.
