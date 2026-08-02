# React Code Review Plugin

Modular code review workflows for **React** codebases, packaged as a Claude plugin.

This is not a general-purpose review system. Every rule module assumes the code under review is a React application; modules that need more than that (FSD, Electron, Tailwind, React Three Fiber) declare it in their own header and are skipped when the assumption does not hold.

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

## Rule modules

Numbered modules (`review-rules/[0-9]*.md`) are loaded by the general review passes. The numbering is contiguous and doubles as execution order — **rule IDs always match the file prefix**.

| # | Module | Focus |
|---|--------|-------|
| 00 | `00-rule.md` | Common rules — scope, rule-ID convention, report output |
| 01 | `01-fsd.md` | FSD layers, public API, feature naming *(FSD only)* |
| 02 | `02-type.md` | Type safety, props typing, narrowing |
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

Non-numbered modules are excluded from the automatic scan and load only in their own workflow:

- `fast.md` — compressed ruleset for `/code-review-fast`
- `props.md` — `P-x` rules for `/code-review-props`
- `math.md` — `A-x` / `C-x` rules for `/code-review-math`
- `exception.md` — `EX-x` rules for `/code-review-exception`

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

## Rule directory resolution

Skills resolve the rules directory in this order and use the first that exists:

1. `${CLAUDE_PLUGIN_ROOT}/review-rules/` — installed as a plugin
2. `./review-rules/` — vendored into the repository
3. `~/.claude/review-rules/` — copied into the home configuration

Skills never hardcode the module list; they enumerate the directory at runtime, so adding or removing a module requires no skill changes.

## Included agent

`agents/correctness-reviewer.md` is an optional evidence-first correctness reviewer (does the implementation match the PR's stated intent across all branches?). It is not part of the default workflows — invoke it explicitly when you want a correctness pass alongside the rule-based review.

## Directory structure

```text
claude-code-review-plugin/
├── .claude-plugin/plugin.json
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
│   ├── 00-rule.md … 20-deletion-regression.md
│   ├── fast.md
│   ├── props.md
│   ├── math.md
│   └── exception.md
└── README.md
```

`skills/` and `review-rules/` must stay together. Do not copy the skill files without the rules.

## Maintenance notes

- Adding a numbered module: insert it at the position that matches its topic, renumber the neighbours, and update every cross-reference plus the matching section of `fast.md`.
- `fast.md` is a hand-maintained compression of the numbered modules. When compressing, keep the original exception clauses — dropping them turns a rule into a false positive.
- Project-specific assumptions belong in each module's header, not in this README.
