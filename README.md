# Custom Code Review Plugin

Modular code review workflows for Claude-based review sessions.

This plugin packages a local review system into a reusable structure with:

- `/code-review` — bounded default review
- `/code-review-fast` — compressed fast review
- `/code-review-commit` — single-commit review
- `/code-review-full` — exhaustive multi-pass review
- `/code-review-props` — props and argument flow review
- `/code-review-math` — linear algebra / matrix-focused review
- `/code-review-exception` — exception handling and recovery review
- `/code-review-qualitative` — qualitative 1~5 rubric scoring via an LLM-as-a-judge panel
- `/full-project-review`: manual risk-based whole-project release gate

## Included Rule Sets

- Common review rules
- FSD architecture review
- Type safety review
- State/effect review
- Structure/JSX review
- Naming/comment/constants review
- Code quality review
- Principles review
- Styling review
- DX review
- Performance review
- Intent/tradeoff review
- Deletion/regression review
- Fast compressed review rules
- Props-specific review rules
- Math-specific review rules
- Exception-specific review rules
- Full-project release-gate rules

## Important Assumptions

This rule set is not fully generic.

Some modules assume a stack like:

- FSD architecture
- Electron process boundaries
- Tailwind + semantic design tokens
- optional Three.js rendering patterns

If your project does not use these patterns, some modules should be adapted before use.

## Directory Structure

```text
custom-code-review-plugin/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── code-review/SKILL.md
│   ├── code-review-fast/SKILL.md
│   ├── code-review-commit/SKILL.md
│   ├── code-review-full/SKILL.md
│   ├── code-review-props/SKILL.md
│   ├── code-review-math/SKILL.md
│   ├── code-review-exception/SKILL.md
│   ├── code-review-qualitative/SKILL.md
│   └── full-project-review/SKILL.md
├── review-rules/
│   ├── 00-rule.md
│   ├── 01-fsd.md … 12-deletion-regression.md
│   ├── fast.md
│   ├── props.md
│   ├── math.md
│   ├── exception.md
│   └── full-project-review.md
└── README.md
```

## Installation

Clone this repository and copy the plugin contents into your Claude plugin or local Claude configuration workflow.

At minimum, the following must stay together:

- `skills/code-review/`
- `skills/code-review-fast/`
- `skills/code-review-commit/`
- `skills/code-review-full/`
- `skills/code-review-props/`
- `skills/code-review-math/`
- `skills/code-review-exception/`
- `skills/code-review-qualitative/`
- `skills/full-project-review/`
- `review-rules/`

Do not copy only the skill files without the review rules.

## Workflows

### `/code-review`
Runs the bounded default review using one consolidated pass over numbered rule modules.

### `/code-review-fast`
Runs a compressed, high-signal review with at most one key issue per file.

### `/code-review-commit`
Scopes review to a single commit patch instead of a whole branch.

### `/code-review-full`
Runs exhaustive multi-pass review across general, props, math, and exception coverage.

This remains a separate existing command. It is not replaced by, aliased to, or delegated to `/full-project-review`.

### `/code-review-props`
Reviews props drilling, handler tunneling, and excessive argument passing.

### `/code-review-math`
Reviews matrix and linear algebra logic with shape-tracking rules.

### `/code-review-exception`
Reviews exception handling, error propagation, fallback, and recovery paths.

### `/code-review-qualitative`
Scores a diff on 1~5 qualitative rubrics (architecture appropriateness, consistency/convention fit) via a 5-judge LLM-as-a-judge panel. Excluded from the default `/code-review`.

### `/full-project-review`
Runs a separate manual, risk-based whole-project release gate. It is not a replacement for `/code-review` or `/code-review-full`, and those commands remain separate existing workflows.

The top-level result is `PASS`, `WARN`, or `BLOCK`. Only Critical project defects produce release-blocking `BLOCK`; non-Critical findings stay `WARN` or TODO unless the review cannot meaningfully run, which is reported as `BLOCK: Orchestration Failure`.

## Maintenance Notes

- If numbered modules change, update `review-rules/fast.md` too. The current numbered inventory is `00-rule.md` through `12-deletion-regression.md`.
- If new review workflows are added, keep naming aligned across `skills/` and output filename rules (`./review-reports/{workflow-name}-{branch-name}-{date}.md` convention).
- Project-specific assumptions should be documented in each rule module header.
