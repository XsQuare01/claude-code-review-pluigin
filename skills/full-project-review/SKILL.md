---
name: full-project-review
description: Use when the user invokes /full-project-review or asks for a manual risk-based whole-project release gate review.
---

# Full Project Review

## Purpose

`/full-project-review` is a separate manual release gate skill for risk-based whole-project review. It looks across the project to find release-blocking defects, but it is not an exhaustive equal-depth scan of every file.

The goal is to decide whether the project is safe to release, document the evidence behind that decision, and prepare a fix plan only when the final result is `Verdict: BLOCK`.

## When to Use

Use this skill when the user invokes `/full-project-review` exactly, or when they ask for a manual, risk-based, whole-project release gate review.

Use it near release readiness, before shipping, or when the user needs a project-level risk verdict instead of a branch-diff review.

## Must Not Change

- Existing `/code-review` behavior must remain unchanged.
- Existing `/code-review-full` behavior must remain unchanged.
- This skill is not a replacement for `/code-review`.
- This skill is not a replacement for `/code-review-full`.
- This skill is not an alias of `/code-review` or `/code-review-full`.
- This skill does not delegate to `/code-review` or `/code-review-full`.
- Do not make `/code-review-full` call, alias, or delegate to `/full-project-review`.
- Do not edit application code, review rules, plugin metadata, README files, dependency files, or installed mirror files while performing this review unless a separate task explicitly asks for that change.

## Workflow

Run the review as a high-level release gate workflow:

1. project inventory: identify project type, entry points, build and test commands, dependency surfaces, runtime configuration, release artifacts, and critical user paths.
2. risk targeting: choose review targets by release impact, change blast radius, security exposure, data loss risk, deletion risk, operational risk, and areas with weak verification.
3. review execution: inspect selected high-risk paths deeply enough to support a release verdict. Do not pretend that untouched low-risk areas received the same depth.
4. severity normalization: classify findings consistently across the project and separate project defects from orchestration failures.
5. verdict generation: produce a release verdict with evidence, limitations, and prioritized TODOs.
6. fix-plan generation: if and only if the final result is `Verdict: BLOCK`, generate a BLOCK fix plan under the rule contract. Do not apply it automatically.

Existing review rules may inform candidate findings, but `/full-project-review` owns final severity normalization and verdict.

## Review Lanes

Use bounded review lanes to organize review execution after the Risk Index is created. Lanes are selected through the Risk Index and risk targeting; not every lane must run at equal depth if it is not risk-selected. This caps scope through risk targeting rather than exhaustive scanning.

The available review lanes are:

- architecture
- security/secrets
- API/contracts
- data/persistence/migrations
- CI/deployment/config
- tests/coverage signals
- dependency/package boundaries

Each selected lane must report:

- evidence inspected
- limitations/exclusions
- candidate findings
- confidence/depth
- whether follow-up is needed

If agents, tools, or specialized review rules are used to help inspect a lane, keep that help bounded to the risk-selected scope. Do not make existing specialized review commands mandatory dependencies, do not alter their behavior, and do not spawn unbounded review work.

## Output Contract

The final report must point to the report contract without implementing the full rule contract here. Include these sections:

- Verdict: PASS, WARN, or BLOCK.
- Risk targeting method: why these areas were inspected and what was intentionally lower priority.
- Findings by severity: Critical, High, Medium, Low, Info, with file paths and evidence where possible.
- Prioritized TODOs: ordered remediation or follow-up items.
- BLOCK fix plan: included only for `Verdict: BLOCK`.
- Evidence / Transcript: commands run, files inspected, agents used, and important outputs.
- Exclusions / Limitations: what was not reviewed, what could not be verified, and why.

## BLOCK Policy

Only Critical project defects block release. A Critical project defect is a confirmed issue that can directly cause release failure, data loss, security exposure, destructive behavior, broken core flows, or other severe project-level harm.

Orchestration failure is labeled separately as `BLOCK: Orchestration Failure`, a BLOCK subtype rather than a fourth top-level verdict. Missing coverage, failed agents, timeouts, unavailable commands, or incomplete evidence must not be disguised as a Critical project defect, and must not be reported as a completed release gate review.

## Fix Plan Behavior

Generate a BLOCK fix plan only for `Verdict: BLOCK`. `Verdict: WARN` and `Verdict: PASS` do not get BLOCK fix plans, though they may include TODOs or follow-up notes.

Follow the `## BLOCK Fix Plan` section in `review-rules/full-project-review.md` for the required schema, output placement, mutation boundary, and `.sisyphus/plans/*.md` behavior.

By default, print or report the BLOCK fix plan in the review result. Write a fix plan to `.sisyphus/plans/*.md` only when the runtime or user explicitly asks for plan creation after the review.

No auto-fix. The fix plan is never applied automatically, and it does not authorize auto-formatting, auto-committing, publishing, dependency upgrades, or application-code changes during the review.

## Verification

This skill is read-only during review execution:

- Do not auto-fix.
- Do not auto-format.
- Do not auto-commit.
- Do not publish.
- Do not upgrade dependencies.
- Do not modify application code during the review.

Verification should prove the release gate process ran far enough to support the verdict. Record commands, diagnostics, test results, build results, inspected paths, skipped paths, and failed checks in the evidence section of the report.
