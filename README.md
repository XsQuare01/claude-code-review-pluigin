# Custom Code Review Plugin

Modular code review workflows for Claude-based review sessions.

This plugin packages a local review system into a reusable structure with:

- `/code-review` — full multi-pass review
- `/code-review-fast` — compressed fast review
- `/code-review-commit` — single-commit review
- `/code-review-math` — linear algebra / matrix-focused review

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
- Fast compressed review rules
- Math-specific review rules

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
│   └── code-review-math/SKILL.md
├── review-rules/
│   ├── 00-rule.md
│   ├── 01-fsd.md … 11-intent.md
│   ├── fast.md
│   └── math.md
└── README.md
```

## Installation

Clone this repository and copy the plugin contents into your Claude plugin or local Claude configuration workflow.

At minimum, the following must stay together:

- `skills/code-review/`
- `skills/code-review-fast/`
- `skills/code-review-commit/`
- `skills/code-review-math/`
- `review-rules/`

Do not copy only the skill files without the review rules.

## Workflows

### `/code-review`
Runs modular multi-pass review using numbered rule modules.

### `/code-review-fast`
Runs a compressed, high-signal review with at most one key issue per file.

### `/code-review-commit`
Scopes review to a single commit patch instead of a whole branch.

### `/code-review-math`
Reviews matrix and linear algebra logic with shape-tracking rules.

## Maintenance Notes

- If numbered modules change, update `review-rules/fast.md` too.
- If new review workflows are added, keep naming aligned across `skills/` and output filename rules (`{branch-name}-{Date}` convention).
- Project-specific assumptions should be documented in each rule module header.
