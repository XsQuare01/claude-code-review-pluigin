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
| MINOR (`2.2.1` → `2.3.0`) | a new rule module file, a workflow gaining a substantial validated capability it did not have, **or an intentionally accepted internal producer→orchestrator interface change for registered structured owners when that change adds a substantial validated structured-output capability while public Markdown remains compatible** |
| MAJOR | changes that invalidate existing rule IDs or past reports |

When unsure, use PATCH. The version here is a cache key and a change signal, not a compatibility contract — nothing resolves it as a dependency range, so an over-large bump communicates something that did not happen, while an extra patch number costs nothing.

`scripts/check-version-bump.mjs` enforces this in CI: any pull request whose diff is non-empty must change the version, or the check fails. The script guidance mirrors the same policy: an internal protocol change alone is not automatically MINOR, but the registered structured-owner upgrade in `2.4.0` counts because it added a substantial validated structured-output capability without breaking the public Markdown contract.

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

`/code-review-full` accepts `--verify` to control its cross-verification pass — `selective` (default), `exhaustive`, or `off`. See [Cross-verification](#cross-verification-25) below.

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

### Location checking in `/code-review` (2.6.1)

`/code-review` findings get their quoted lines compared against the files they name. A quote that does not match becomes `위치 미확인` with a reason; the finding itself stays, because a wrong line number does not make a claim false.

The command stays a legacy Markdown producer and keeps its single sub-agent. It emits a small `REVIEW_LOCATIONS` block — four fields per finding — alongside its table, and the orchestrator pipes that to the check. `2.6.0` tried moving this command to full structured output instead and timed out: one agent covering every module had to write a complete envelope per finding in a single JSON response. Four fields is what a consolidated pass can afford.

Missing or malformed, the block costs nothing — the report says `대조 미실행` and keeps every finding. There is no corrective retry, because retrying a large single response is part of what timed `2.6.0` out.

### Structured producer results, accepted internal interface in 2.4.0

`REVIEW_RESULT_CONTRACT_V1` is an intentionally accepted **internal producer→orchestrator interface change**. It ships in `2.4.0` as a **MINOR** change because the public Markdown report stays stable while a registered set of producers moves to a structured envelope.

Structured-v1 owners **when this interface shipped in 2.4.0** were:

- `/code-review-full` for numbered modules plus its full specialist dispatch
- `/code-review-props`
- `/code-review-math`
- `/code-review-exception`

and the legacy producers were `/code-review`, `/code-review-commit` and `/code-review-fast`.

**Current ownership (2.6.0)** — `/code-review` joined the structured owners when it gained its location check, so:

| Structured-v1 owners | Legacy producers |
|---|---|
| `/code-review`, `/code-review-full`, `/code-review-props`, `/code-review-math`, `/code-review-exception` | `/code-review-commit`, `/code-review-fast` |

`workflow-contract.md` C-6A is the authority; this table is a summary of it.

`agents/correctness-reviewer.md` is **not** a phase-1 structured-v1 owner. It stays an optional direct/evidence-first agent until a built-in orchestrator consumer exists that validates and renders its output.

Numbered rule modules and specialist rule docs are **workflow-neutral domain judgment docs**. They explain what facts a useful finding should cover, but they do not own schema fields, retry policy, renderer behavior, or raw-output instructions.

For structured owners, producers return one raw JSON object with `findings` and `openQuestions`; they do not return Markdown or `severity`. A finding records `impact`, `confidence`, and a `verified`, `deleted`, or `unverified` location. An `unverified` location carries a reason instead of a made-up path or line, and it remains a finding when the defect is established but the exact anchor cannot yet be verified. `openQuestions` is for unresolved claim truth or search scope instead — especially incomplete absence/possibility claims under `00-11`, or explicit follow-up investigation. High-impact findings must name one of five closed categories: user malfunction, data loss, security exposure, verification failure, or external breakage. Low-impact findings may carry `evidence`, but do not require it. Correctness keeps the same `CR-{n}` namespace and location semantics, but because no built-in workflow currently validates/renders its output, it remains direct-only rather than pretending to be a consumer-backed V1 producer.

The orchestrator validates those results, aggregates only valid JSON, derives severity from `impact × confidence`, and renders the final Markdown report. Deduplication is owned by the shared workflow contract: only findings with the same rule ID, the same verified/deleted normalized location, the same core claim / root cause / breaking condition, the same impact/category, and the same confidence may merge. `unverified` findings and `openQuestions` never auto-merge; source labels are preserved when valid merges do happen. JSON conformance is prompt-only, not a native model-output schema. Malformed structured output **or legacy/prose output from a structured owner** gets one corrective retry; a second malformed response ends that pass as `FAILED malformed-output` rather than being partially parsed or repaired. There is **no compatibility parser** for legacy/prose output in structured-v1 owners.

Producer strings are treated as untrusted report content. The renderer places fields by slot rather than trusting producer-authored Markdown, escapes control/block Markdown in prose fields so they cannot create headings, fences, tables, raw HTML, or links that look orchestrator-authored, renders `location.quote` in a safe code form with delimiter escaping, renders paths as code, and leaves any URLs as plain text. The static validator checks that the contract and prompts stay synchronized on those rules; it does not claim to execute or prove the renderer.

## Cross-verification (2.5.0)

`/code-review-full` no longer treats a single module agent's judgement as settled fact. After the first pass it re-examines findings along a **different axis** — anchor-file context rather than rule module — and asks a verifier to refute them.

It does not re-review the same diff with the same rules. Two agents given the same model, the same input, and a similar prompt make correlated mistakes, and a majority vote between them does not establish that a finding is true.

| `--verify` | Behaviour |
|------------|-----------|
| `selective` (default) | Only candidates that meet a deterministic eligibility test are verified — high impact, low confidence, an unverified or mismatched location, or two different rules anchored on the same line |
| `exhaustive` | Every candidate is verified. Writes a `VerificationAuditSidecar` next to the report |
| `off` | Location checking still runs; no verifier agents are spawned |

**Location checking and eligibility are decided by `scripts/prepare-verification.mjs`, not by a model.** The orchestrator runs it — `node scripts/prepare-verification.mjs --merge-base <sha>` takes the producer results it already holds on stdin, assigns each finding a `{ruleId}#{n}` id and returns each one's location check, eligibility and route along with the coverage counts, so the numbers in the report are derived rather than tallied by hand. Nothing forces a run, so the report has to say where its coverage numbers came from — a hand-tallied count that happens to add up is still labelled as one. Comparing a finding's quoted line against the file it claims to come from is a mechanical check, and describing it in Markdown would not make it deterministic. Line endings are normalized and the ends are trimmed, but internal whitespace is preserved — collapsing it would make `"x  y"` and `"x y"` compare equal, which is the exact class of difference the check exists to catch.

**A refuted finding is not deleted yet.** Removing a finding from the report cannot be undone, and when the refutation is wrong the report simply looks cleaner — the failure is invisible. So deletion starts in `rollout-shadow`, where a refuted finding stays visible, keeps its severity, and **still blocks the merge**. Moving to `active-deletion` requires measured suppression accuracy rather than elapsed time, and `high` and `low` impact are promoted independently.

A verifier that cannot fit its objection into the closed list of rebuttal kinds uses `other`, which records the objection and changes nothing else. It never removes a finding and never releases a block.

Verifier failure is not orchestration failure. An unverified finding stays in the report and keeps blocking, because treating "we could not check this" as "this was disproven" would make killing the verifier a way to erase findings.

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
| Correctness agent | `CR-{n}` | `CR-2` |

`CR-` is a separate namespace on purpose. The correctness pass argues from the PR's stated intent rather than from a rule document, so borrowing a module's ID would send the reader to rule text that says nothing about the finding.

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

`agents/correctness-reviewer.md` is an optional evidence-first correctness reviewer (does the implementation match the PR's stated intent across all branches?). It is not part of the default workflows and not part of phase-1 structured-v1 ownership — invoke it explicitly when you want a correctness pass alongside the rule-based review.

It answers a question the rule modules do not: a module asks whether the code breaks a rule, this pass asks whether the code does what the PR says it does. Because its findings land in the same report, it is bound by the same contract — read-only execution (`00-9`), verified line numbers with a quoted line (`00-10`), and stated search scope behind any absence claim (`00-11`) — and its findings carry `CR-{n}` IDs. The `agent` check in `scripts/validate-rules.mjs` enforces that: an agent document that cites no contract clause, or uses an ID prefix registered nowhere, fails the build. Being outside the workflows is a scoping decision; being outside the contract was an oversight.

## Directory structure

```text
claude-code-review-plugin/
├── .claude-plugin/plugin.json
├── .github/workflows/validate.yml
├── LICENSE
├── scripts/validate-rules.mjs
├── tests/
│   ├── effective-common-context-validator.test.mjs
│   └── workflow-fixtures.md
├── docs/                          # design records, not current state
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
node --test tests/effective-common-context-validator.test.mjs
node scripts/validate-rules.mjs
```

No dependencies, no install step. CI runs it on every pull request and a failure blocks the merge.

Unit tests for the deterministic verification module run alongside it:

```bash
node --test tests/*.test.mjs
```

It checks the properties this repo promises but cannot hold by hand:

| Check | What it catches |
|-------|-----------------|
| `inventory` | gaps or duplicates in module numbering |
| `rule-id` | a heading whose ID disagrees with its file prefix; duplicate IDs |
| `cross-ref` | a reference to a module file or rule ID that does not exist |
| `readme` | README inventory out of step with the actual files |
| `skill` | a skill that does not defer to the contract, declares an unregistered `workflow-name`, or points at a missing rule document |
| `verdict-fixtures` | a cross-verification verdict fixture whose expected error codes drifted from the validator |
| `verdict-contract` | a verdict contract that no skill injects, or an owner naming a disposition or rebuttal kind the manifest does not define |
| `clause-refs` | a skill pointing at a `C-` contract clause that `workflow-contract.md` does not define |
| `restatements` | a C-6B rule the owner skill never restates, so an orchestrator reading only the skill cannot follow it — this is how a shadow-rejected blocker got dropped from a verdict |
| `render-tokens` | a report rendering a cross-verification status the contract never declared, which is how producer enums leak into public output |
| `catalog` | a module scheduled out of the normal fan-out in `catalog.json` without the matching declaration in C-2, or without the workflow's own skill excluding it — either gap makes the module run twice or count as missing |
| `fixtures` | two workflow-contract scenarios sharing an id, which makes a regression impossible to attribute |
| `fast-sync` | a missing digest section, a conditional rule whose applicability, exception, or typical impact calibration was lost in compression, a stale module range |
| `hardcoded-path` | `~/.claude/review-rules` re-introduced into a skill instead of using the resolution order |
| `catalog` | a module with no catalog entry, an entry pointing at a missing file, an undefined profile, a profile with no detection signal, a mistyped or incomplete signal, a profile reference cycle, a profile no module requires, workflow membership that disagrees with the module set a skill declares it loads |
| `manifest` | missing manifest fields, plugin/marketplace disagreement, a second `version` string anywhere in `marketplace.json`, a packaged directory that is absent, skill frontmatter without name or description |
| `agent` | an agent document that cites no contract clause, states no read-only/position/absence handling, or uses a finding ID prefix registered in neither `00-rule.md` nor this README |
| `structured-contract` | drift in the canonical `REVIEW_RESULT_CONTRACT_V1` manifest in `workflow-contract.md`, required fields, enums, location variants, low-impact evidence policy, rendering-safety tokens, ownership matrix sync, or closed high-impact categories |
| `structured-producer` | a structured owner missing the V1 marker/sentinel, a legacy workflow claiming structured ownership, or a workflow-neutral rule module leaking schema/raw-output/render instructions |
| `fixtures` | a contract clause with no scenario in `tests/workflow-fixtures.md` or missing owner-specific structured/legacy cases |

The validator also runs JSON fixtures through the static V1 shape checks, including required arrays, forbidden severity, conditional impact/confidence fields, closed categories, and verified/deleted/unverified location rules.

**What it does not check.** Whether a workflow actually behaves as the contract says. It does not execute the model, the one-retry failure path, aggregation, or Markdown rendering. `tests/workflow-fixtures.md` lists runtime scenarios for manual runs. Semantic preservation also remains manual: compare representative legacy Markdown and V1-rendered reports for the same findings, specialist details, unverified locations, and open questions. Markdown escaping is documented and synchronized statically, but not runtime-proven here. The validator does not use prose regex as the primary contract; stable owner markers and inverse rule-module neutrality checks are the primary guardrails. It still does not claim or prove semantic equivalence.

## Maintenance notes

- Adding a numbered module: **append the next free number — never renumber existing modules.** Rule IDs are quoted in review reports and in this repo's own cross-references, so renumbering silently invalidates every past report and breaks traceability, which is the one property the ID convention exists to provide. Grouping by topic is a readability preference; stable IDs are a correctness property, and the latter wins. Add the module to the README inventory and to the matching section of `fast.md` in the same change.
- `fast.md` is a hand-maintained compression of the numbered modules. Three things must match the source exactly: **applicability conditions**, **exception clauses**, and **typical impact calibration**. Final finding severity still comes from the global two-axis derivation, but if the digest loses applicability, exceptions, or source calibration cues, fast review stops being a faithful compression.
- Project-specific assumptions belong in each module's header, not in this README.
