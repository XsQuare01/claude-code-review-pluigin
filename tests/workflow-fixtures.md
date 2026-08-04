# Workflow contract fixtures

These scenarios pin the behaviour that `review-rules/workflow-contract.md` promises.

**They are not automated.** A review workflow is a prose instruction set executed by a language model, so its behaviour cannot be asserted by running a function — only by running a review and reading the result. What `scripts/validate-rules.mjs` does check is that every contract clause has a scenario here and that no scenario cites a clause that does not exist, so the checklist cannot silently fall out of sync with the contract.

Run these by hand after changing the contract or any skill document. Record the outcome in the PR.

| # | Clause | Scenario | Expected |
|---|--------|----------|----------|
| 1 | C-1 | Plugin installed and a `./review-rules/` also present in the repo | Plugin path wins; the resolved path appears in the report |
| 2 | C-1 | No rules directory found in any of the three locations | Review stops and says which paths were tried — no partial review |
| 3 | C-2 | A new numbered module file is dropped into the rules directory | It is picked up with no skill edit; it appears in the report's module list |
| 4 | C-2 | Default and full runs | `00-rule.md` is passed as common context to every module, and never dispatched as its own module pass |
| 5 | C-3 | Non-FSD project | `01-fsd.md` is reported `SKIPPED` with a reason — not silently absent, not "✅ 통과" |
| 6 | C-3 | Project on React 18 | `03-10` (React 19 APIs) produces no findings; conditional `use` is not flagged as a Hooks violation |
| 7 | C-3 | SPA with no `'use client'` / `'use server'` and no RSC framework | `21-rsc.md` is `SKIPPED` |
| 8 | C-3 | React version cannot be determined from `package.json` | Version-gated rules do not fire; the module is recorded `UNKNOWN` |
| 9 | C-4 | User passes an explicit range (`main..feature/x`) | That range is used verbatim; no base auto-detection runs |
| 10 | C-4 | No `dev`/`main`/`master` and no `origin/HEAD` | The user is asked for a base; no range is invented |
| 11 | C-4 | `MERGE_BASE == HEAD` (empty diff) | Review does not run; no report file is written |
| 12 | C-5 | Diff touches only `*.test.ts` | Test files produce no style findings, but the changed tests are read as evidence of what behaviour moved (`00-rule.md` 00-1, 00-3) |
| 13 | C-6 | Plain review request, repo has a `lint:fix` script | Lint runs without `--fix`; the working tree is unchanged; auto-fixable counts are reported, not applied |
| 14 | C-6 | User says "read-only" / "파일 수정하지 마" / "텍스트로만" | No file is created — including the review report — and the result is returned in the response |
| 15 | C-6 | Lint and typecheck were run | Their output appears under `도구 실행 결과`, separate from review findings |
| 16 | C-7 | Default review on branch `feature/x` | Report path is `./review-reports/code-review-default-feature-x-{date}.md` and the path is reported back |
| 17 | C-7 | A report for the same branch and date already exists | A fresh review runs anyway and a new file is written; the existing file is never treated as completion |
| 18 | C-8 | Full run where one module sub-agent times out after its retry | Completed modules are preserved as partial results; the failed module is named; the run is `FAILED orchestration`, not a pass |
| 19 | C-8 | A specialist pass has no applicable files | Reported `SKIPPED` with a reason, marked non-blocking |
| 20 | C-3 | Full run on a project with no FSD, Tailwind, RSC, or Three.js | Those modules are `SKIPPED` **without a sub-agent ever being dispatched**; the report shows candidate count vs applicable count |
| 21 | C-3 | Full run where the diff touches no auth, payment, delete, or secret path | `18-dangerous-change` may be skipped by trigger, and the reason states what was looked for and not found — never skipped silently |
| 22 | C-8 | Full run, one of the in-flight modules finishes far sooner than the others | The freed slot takes the next queued module immediately; it does not wait for the slower ones, and no more than four run at once |
| 23 | C-8 | Full run that hits two or more timeouts / queue expiries | Failure classes and counts appear in the report, so the in-flight cap can be judged against evidence rather than guessed |

## Default-workflow-only scenarios

`--module` belongs to `/code-review` alone, so it is declared in that skill rather than the contract.

| # | Scenario | Expected |
|---|----------|----------|
| 24 | `--module fsd,type` | Only `01` and `02` run; the report states the filter and lists no other module as passing |
| 25 | `--module 01,02,17` | Same selection by number |
| 26 | `--module nope` | Review stops, names the unresolved token, lists available modules — it does not fall back to a full pass |
| 27 | `--module 00` | Explains that common rules always apply, and asks whether a common-rules-only pass was intended |
