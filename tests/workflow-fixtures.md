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
| 24 | C-7 | Full run on branch `feat/x` saves its report | H1 is ``# `feat/x` 전체 코드 리뷰 리포트`` — target **and** workflow name, matching the `full` in the filename, set when writing begins rather than corrected afterwards |
| 25 | C-7 | Any finding in any workflow | Position is a verified post-change line number with the line's code quoted; a finding whose line cannot be confirmed says `위치 미확인` instead of guessing (`00-rule.md` 00-10) |
| 26 | C-7 | A project or user config names a document location (`CLAUDE.md` and similar) | The report is saved there rather than `./review-reports/`, and the path is reported — this is not a violation |
| 27 | C-7 | Two reports for different branches sit in the same folder | Each H1 names its branch, so they are distinguishable without opening the filenames |
| 28 | C-8 | Any finding that claims something is absent or possible | It states what was checked; where the check could not extend past the diff it says `확인 필요` instead of asserting (`00-rule.md` 00-11) |
| 29 | C-7 | Three full runs on different branches | All three have the same section names, order, and heading levels — the skeleton does not vary per run |
| 30 | C-7 | A module sub-agent returns its own `##` headings | The orchestrator normalises them into the skeleton; finding count, wording, the two axes as the author judged them, rule IDs and source labels are unchanged — only a severity marker that contradicts those axes is recomputed |
| 31 | C-3 | Tailwind 4 project — configured in CSS, no `tailwind.config` file | `11-styling.md` **applies**; the report names the signal that matched (`dependency tailwindcss`, or the `@import "tailwindcss"` entry point). A `SKIPPED` here is the false negative `cautions` warns about |
| 32 | C-3 | `'use server'` Server Functions present, no `'use client'` and no RSC framework | `server-code` holds (`17-5`–`17-7` apply); `rsc` does not (`21-rsc.md` is `SKIPPED`) — the directive is not read as RSC evidence |
| 33 | C-3 | Nothing declares that another codebase consumes this repository's contract | `contract-provider` does not hold, `16-5`–`16-7` produce no findings, and the reason states the profile was never declared — it is not inferred from `exports` or a checked-in schema |
| 34 | C-3 | `src/` contains only `shared/` and `features/` | `fsd` does not hold — two layer-shaped directories are below the `min` of 3, so `01-fsd.md` is `SKIPPED` rather than applying layering rules to a non-FSD tree |
| 35 | C-3 | Any profile decision, applied or skipped | The matched signal (or the fact that none matched) appears in the report, so the decision can be checked against `catalog.json` without re-running the review |
| 36 | C-7 | User asks for the report in a language other than Korean | Section names and finding prose follow the request; rule IDs, paths, code quotes, severity markers and the status tokens (`SKIPPED`, `UNKNOWN`, `위치 미확인`, `확인 필요`) are unchanged, and `리뷰 기준` records the language used (`00-rule.md` 00-6) |
| 37 | C-7 | Correctness agent runs alongside a rule-based pass | Its findings carry `CR-{n}` IDs, never a module ID, and sit in the same skeleton with a verified line and quote like any other finding |
| 31 | C-7 | A report has two findings under the same rule ID | They read `17-3 (1/2)` and `17-3 (2/2)`, so a follow-up question about `17-3` is answerable (`00-rule.md` 00-2) |
| 38 | C-7 | Any finding emitted as a `####` heading under the C-7 skeleton (today: `/code-review-full`) | The line under the heading reads `영향: {높음\|낮음} · 확신: {높음\|낮음}`, and the severity marker matches the derivation in `00-rule.md` — 🔴 only when both are 높음. This row pins where the axes are *displayed*; the derivation itself binds every workflow (row 42) |
| 39 | C-7 | A finding that is true but has no user-visible effect — style, consistency, a theoretical inefficiency, in any workflow | It is judged `영향: 낮음`, so it is 🟡 when `확신: 높음` and 🔵 when `확신: 낮음` — never 🔴; it is still reported rather than dropped. This holds whether or not the workflow's output format prints the two axes |
| 40 | C-7 | A finding claims `영향: 높음` | It names which of the five categories in the closed list of `00-rule.md` § Severity 기준 applies — 사용자에게 보이는 오동작 또는 조작 불능 / 데이터 손상·유실 / 보안 노출 / 빌드·타입체크·테스트 실패 / 이 빌드 밖으로 나가는 파손 (다른 코드베이스가 소비하는 계약 파괴, 롤백·복구 경로 상실); a 높음 with no named category is not a valid finding |
| 41 | C-7 | Any report | `리뷰 기준` records the plugin version next to `RULES_DIR` — read per C-1, or `버전 미확인` when `.claude-plugin/plugin.json` is not reachable — so which severity calibration produced the report is readable without re-running it |
| 42 | C-7 | The same defect is reported by a workflow whose format shows the axes (`/code-review-full`, or the `영향·확신` column of `props.md`/`math.md`/`exception.md`) and by one whose format has none yet (`/code-review`, `/code-review-commit`, `/code-review-fast`) | Both carry the same severity, because the derivation binds every workflow — only the display differs. The table-row report is not read as rule-fixed severity; the missing axes are a display gap that makes the grade unverifiable from that report alone, not an exemption from judging them |

## Default-workflow-only scenarios

`--module` belongs to `/code-review` alone, so it is declared in that skill rather than the contract.

| # | Scenario | Expected |
|---|----------|----------|
| 32 | `--module fsd,type` | Only `01` and `02` run; the report states the filter and lists no other module as passing |
| 33 | `--module 01,02,17` | Same selection by number |
| 34 | `--module nope` | Review stops, names the unresolved token, lists available modules — it does not fall back to a full pass |
| 35 | `--module 00` | Explains that common rules always apply, and asks whether a common-rules-only pass was intended |
