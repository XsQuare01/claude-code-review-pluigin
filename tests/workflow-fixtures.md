# Workflow contract fixtures

These scenarios pin the behaviour that `review-rules/workflow-contract.md` promises.

`scripts/validate-rules.mjs` parses the machine-readable block below to keep clause coverage in sync with the contract. The manual scenarios stay prose-only on purpose: they describe behaviour that cannot be statically proven from prompt text alone.

<!-- WORKFLOW_FIXTURES_JSON:BEGIN -->
```json
{
  "contractCases": [
    {
      "id": 1,
      "clauses": [
        "C-1"
      ],
      "scenario": "Plugin installed and a ./review-rules/ also present in the repo",
      "expected": "Plugin path wins; the resolved path appears in the report"
    },
    {
      "id": 2,
      "clauses": [
        "C-1"
      ],
      "scenario": "No rules directory found in any of the three locations",
      "expected": "Review stops and says which paths were tried — no partial review"
    },
    {
      "id": 3,
      "clauses": [
        "C-2"
      ],
      "scenario": "A new numbered module file is dropped into the rules directory",
      "expected": "It is picked up with no skill edit; it appears in the report's module list"
    },
    {
      "id": 4,
      "clauses": [
        "C-2"
      ],
      "scenario": "Default and full runs",
      "expected": "00-rule.md is passed as common context to every module, and never dispatched as its own module pass"
    },
    {
      "id": 5,
      "clauses": [
        "C-3"
      ],
      "scenario": "Non-FSD project",
      "expected": "01-fsd.md is reported SKIPPED with a reason — not silently absent, not pass"
    },
    {
      "id": 6,
      "clauses": [
        "C-3"
      ],
      "scenario": "Project on React 18",
      "expected": "03-10 produces no findings; conditional use is not flagged as a Hooks violation"
    },
    {
      "id": 7,
      "clauses": [
        "C-3"
      ],
      "scenario": "SPA with no use client / use server and no RSC framework",
      "expected": "21-rsc.md is SKIPPED"
    },
    {
      "id": 8,
      "clauses": [
        "C-3"
      ],
      "scenario": "React version cannot be determined from package.json",
      "expected": "Version-gated rules do not fire; the module is recorded UNKNOWN"
    },
    {
      "id": 9,
      "clauses": [
        "C-4"
      ],
      "scenario": "User passes an explicit range (main..feature/x)",
      "expected": "That range is used verbatim; no base auto-detection runs"
    },
    {
      "id": 10,
      "clauses": [
        "C-4"
      ],
      "scenario": "No dev/main/master and no origin/HEAD",
      "expected": "The user is asked for a base; no range is invented"
    },
    {
      "id": 11,
      "clauses": [
        "C-4"
      ],
      "scenario": "MERGE_BASE == HEAD (empty diff)",
      "expected": "Review does not run; no report file is written"
    },
    {
      "id": 12,
      "clauses": [
        "C-5"
      ],
      "scenario": "Diff touches only *.test.ts",
      "expected": "Test files produce no style findings, but the changed tests are read as evidence of what behaviour moved"
    },
    {
      "id": 13,
      "clauses": [
        "C-6"
      ],
      "scenario": "Plain review request, repo has a lint:fix script",
      "expected": "Lint runs without --fix; the working tree is unchanged; auto-fixable counts are reported, not applied"
    },
    {
      "id": 14,
      "clauses": [
        "C-6"
      ],
      "scenario": "User says read-only / 파일 수정하지 마 / 텍스트로만",
      "expected": "No file is created — including the review report — and the result is returned in the response"
    },
    {
      "id": 15,
      "clauses": [
        "C-6"
      ],
      "scenario": "Lint and typecheck were run",
      "expected": "Their output appears under 도구 실행 결과, separate from review findings"
    },
    {
      "id": 16,
      "clauses": [
        "C-6A"
      ],
      "scenario": "A registered structured owner returns valid JSON with findings and openQuestions arrays",
      "expected": "Validation passes and aggregation receives the parsed object unchanged"
    },
    {
      "id": 17,
      "clauses": [
        "C-6A"
      ],
      "scenario": "A registered structured owner returns malformed JSON, forbidden severity field, or legacy/prose output",
      "expected": "The pass is treated as malformed-output and only the corrective retry path is allowed"
    },
    {
      "id": 52,
      "clauses": [
        "C-6A"
      ],
      "scenario": "A numbered module or specialist rule doc contains V1 markers, schema fields, render instructions, or malformed-output prose",
      "expected": "Static validation fails because rule docs must stay workflow-neutral domain judgment docs"
    },
    {
      "id": 53,
      "clauses": [
        "C-6A"
      ],
      "scenario": "default, commit, or fast claims structured-v1 ownership",
      "expected": "Static validation fails because those workflows are explicitly legacy owners in the ownership matrix"
    },
    {
      "id": 54,
      "clauses": [
        "C-6A",
        "C-7"
      ],
      "scenario": "correctness remains a direct-only evidence-first agent with CR namespace and shared location discipline",
      "expected": "It is not V1 until an orchestrator consumer exists; static validation fails if correctness declares structured-v1 ownership before a validation/render consumer is registered"
    },
    {
      "id": 55,
      "clauses": [
        "C-6A",
        "C-7"
      ],
      "scenario": "Policy-bearing common instruction context must carry machine markers saying workflow-contract.md owns representation and that 위치 미확인 is forbidden except inside one explicit public-output allow block; canonical manifest renderer labels remain independently validated data",
      "expected": "Static validation fails unless the marker-driven absence guard keeps structured raw output on location.kind=unverified plus reason and allows 위치 미확인 only inside the marked public/legacy allow block"
    },
    {
      "id": 50,
      "clauses": [
        "C-6A"
      ],
      "scenario": "A structured producer establishes a defect but cannot verify the exact line",
      "expected": "It may return a finding with location.kind=unverified and reason only; this does not get demoted to openQuestions unless the claim truth or search scope itself is unresolved"
    },
    {
      "id": 51,
      "clauses": [
        "C-6A"
      ],
      "scenario": "A producer returns prose that contains Markdown heading, fence, table, raw HTML, or link syntax in title/body/evidence",
      "expected": "The orchestrator renders fields by slot and escapes that control syntax so it cannot appear as orchestrator-authored structure; static validation only checks contract/prompt sync, not renderer execution"
    },
    {
      "id": 18,
      "clauses": [
        "C-7"
      ],
      "scenario": "Default review on branch feature/x",
      "expected": "Report path is ./review-reports/code-review-default-feature-x-{date}.md and the path is reported back"
    },
    {
      "id": 19,
      "clauses": [
        "C-7"
      ],
      "scenario": "A report for the same branch and date already exists",
      "expected": "A fresh review runs anyway and a new file is written; the existing file is never treated as completion"
    },
    {
      "id": 20,
      "clauses": [
        "C-7"
      ],
      "scenario": "Full run on branch feat/x saves its report",
      "expected": "H1 includes both the target and the workflow name and is set when writing begins"
    },
    {
      "id": 21,
      "clauses": [
        "C-7"
      ],
      "scenario": "Any finding in any workflow",
      "expected": "Position is a verified post-change line number or range with the line's code quoted; a structured raw producer represents an unconfirmed line as location.kind=unverified plus reason, its renderer later emits 위치 미확인 사유, and legacy/direct public output keeps 위치 미확인 instead of guessing"
    },
    {
      "id": 22,
      "clauses": [
        "C-7"
      ],
      "scenario": "A project or user config names a document location",
      "expected": "The report is saved there rather than ./review-reports/, and the path is reported"
    },
    {
      "id": 23,
      "clauses": [
        "C-7"
      ],
      "scenario": "Two reports for different branches sit in the same folder",
      "expected": "Each H1 names its branch, so they are distinguishable without opening filenames"
    },
    {
      "id": 24,
      "clauses": [
        "C-7"
      ],
      "scenario": "Three full runs on different branches",
      "expected": "All three have the same section names, order, and heading levels — the skeleton does not vary per run"
    },
    {
      "id": 25,
      "clauses": [
        "C-7"
      ],
      "scenario": "A module sub-agent returns its own headings",
      "expected": "The orchestrator normalises them into the shared skeleton while preserving content and recomputing only derived severity"
    },
    {
      "id": 26,
      "clauses": [
        "C-7"
      ],
      "scenario": "User asks for the report in a language other than Korean",
      "expected": "Section names and prose follow the request; rule IDs, paths, quotes, severity markers and status tokens stay fixed"
    },
    {
      "id": 27,
      "clauses": [
        "C-7"
      ],
      "scenario": "Correctness agent runs alongside a rule-based pass",
      "expected": "Its findings carry CR-{n} IDs and use the same skeleton and verified-line discipline as other findings"
    },
    {
      "id": 28,
      "clauses": [
        "C-7"
      ],
      "scenario": "A report has two findings under the same rule ID",
      "expected": "They read 17-3 (1/2) and 17-3 (2/2), so a follow-up question about 17-3 is answerable"
    },
    {
      "id": 29,
      "clauses": [
        "C-7"
      ],
      "scenario": "Any finding emitted as a #### heading under the C-7 skeleton",
      "expected": "The line under the heading reads 영향: {높음|낮음} · 확신: {높음|낮음}, and the severity marker matches the derivation in 00-rule.md"
    },
    {
      "id": 30,
      "clauses": [
        "C-7"
      ],
      "scenario": "A finding that is true but has no user-visible effect",
      "expected": "It is judged impact low, so it is never rendered as red regardless of whether the workflow prints the axes"
    },
    {
      "id": 31,
      "clauses": [
        "C-7"
      ],
      "scenario": "A finding claims impact high",
      "expected": "It names one of the five closed categories from 00-rule.md; a high-impact finding with no named category is invalid"
    },
    {
      "id": 32,
      "clauses": [
        "C-7"
      ],
      "scenario": "Any report",
      "expected": "리뷰 기준 records the plugin version next to RULES_DIR, or 버전 미확인 when plugin.json is unreachable"
    },
    {
      "id": 33,
      "clauses": [
        "C-7"
      ],
      "scenario": "The same defect is reported by workflows with and without visible axes",
      "expected": "Both carry the same derived severity; the difference is display, not judgment"
    },
    {
      "id": 34,
      "clauses": [
        "C-8"
      ],
      "scenario": "Full run where one module sub-agent times out after its retry",
      "expected": "Completed modules are preserved as partial results; the failed module is named; the run is FAILED orchestration"
    },
    {
      "id": 35,
      "clauses": [
        "C-8"
      ],
      "scenario": "A specialist pass has no applicable files",
      "expected": "Reported SKIPPED with a reason, marked non-blocking"
    },
    {
      "id": 36,
      "clauses": [
        "C-8"
      ],
      "scenario": "Any finding that claims something is absent or possible",
      "expected": "It states what was checked; where the check could not extend past the diff it says 확인 필요 instead of asserting"
    },
    {
      "id": 37,
      "clauses": [
        "C-8"
      ],
      "scenario": "Full run, one of the in-flight modules finishes far sooner than the others",
      "expected": "The freed slot takes the next queued module immediately; it does not wait for the slower ones, and no more than four run at once"
    },
    {
      "id": 38,
      "clauses": [
        "C-8"
      ],
      "scenario": "Full run that hits two or more timeouts or queue expiries",
      "expected": "Failure classes and counts appear in the report so the in-flight cap can be judged against evidence"
    },
    {
      "id": 43,
      "clauses": [
        "C-3"
      ],
      "scenario": "Full run on a project with no FSD, Tailwind, RSC, or Three.js",
      "expected": "Those modules are SKIPPED without a sub-agent ever being dispatched; the report shows candidate count vs applicable count"
    },
    {
      "id": 44,
      "clauses": [
        "C-3"
      ],
      "scenario": "Full run where the diff touches no auth, payment, delete, or secret path",
      "expected": "18-dangerous-change may be skipped by trigger, and the reason states what was looked for and not found — never skipped silently"
    },
    {
      "id": 45,
      "clauses": [
        "C-3"
      ],
      "scenario": "Tailwind 4 project configured in CSS, with no tailwind.config file",
      "expected": "11-styling.md applies; the report names the signal that matched, such as dependency tailwindcss or the @import \"tailwindcss\" entry point"
    },
    {
      "id": 46,
      "clauses": [
        "C-3"
      ],
      "scenario": "'use server' Server Functions present, with no 'use client' and no RSC framework",
      "expected": "server-code holds so 17-5 through 17-7 apply, while rsc does not and 21-rsc.md is SKIPPED; the directive is not read as RSC evidence"
    },
    {
      "id": 47,
      "clauses": [
        "C-3"
      ],
      "scenario": "Nothing declares that another codebase consumes this repository's contract",
      "expected": "contract-provider does not hold, 16-5 through 16-7 produce no findings, and the reason states the profile was never declared rather than inferred"
    },
    {
      "id": 48,
      "clauses": [
        "C-3"
      ],
      "scenario": "src contains only shared and features directories",
      "expected": "fsd does not hold because the layer-shaped directory count stays below min=3, so 01-fsd.md is SKIPPED rather than applied"
    },
    {
      "id": 49,
      "clauses": [
        "C-3"
      ],
      "scenario": "Any profile decision, applied or skipped",
      "expected": "The matched signal, or the fact that none matched, appears in the report so the decision can be checked against catalog.json without re-running the review"
    },
    {
      "id": 56,
      "clauses": [
        "C-6B"
      ],
      "scenario": "A verifier returns rejected for a high-impact finding while deletionPhase.high is rollout-shadow",
      "expected": "The finding stays in the active report marked 반박됨 — 관찰 중, keeps its original severity, and still blocks the merge; the counterfactual deletion is recorded only in the audit"
    },
    {
      "id": 57,
      "clauses": [
        "C-6B"
      ],
      "scenario": "A verifier returns rejected with rebuttal.kind other",
      "expected": "The finding keeps its active status, severity, and blocking in every phase — other never removes a finding and never releases a block"
    },
    {
      "id": 58,
      "clauses": [
        "C-6B"
      ],
      "scenario": "The verify pass runs with --verify off and a high-impact candidate is eligible",
      "expected": "The candidate is recorded as verification-disabled, stays active and blocking, and is counted separately from verification-unavailable in coverage"
    },
    {
      "id": 59,
      "clauses": [
        "C-6B"
      ],
      "scenario": "A verifier agent times out on a high-impact candidate",
      "expected": "The candidate is verification-unavailable, stays active and blocking (fail-open), and the whole review is not marked FAILED orchestration"
    },
    {
      "id": 60,
      "clauses": [
        "C-6B"
      ],
      "scenario": "deletionPhase.low is active-deletion while deletionPhase.high is rollout-shadow",
      "expected": "Low-impact rejected findings are removed while high-impact rejected findings remain active — the phase is per impact, not global"
    },
    {
      "id": 61,
      "clauses": [
        "C-6B"
      ],
      "scenario": "An exhaustive run and a selective run, each with an explicit read-only request",
      "expected": "Neither writes an audit sidecar file and both report audit persistence disabled; the exhaustive default to persist yields to the user's read-only request"
    },
    {
      "id": 62,
      "clauses": [
        "C-6B",
        "C-6"
      ],
      "scenario": "An exhaustive run with no read-only request",
      "expected": "A VerificationAuditSidecar is written containing every candidate's disposition, but not the original finding text or free-form evidence"
    },
    {
      "id": 63,
      "clauses": [
        "C-6B"
      ],
      "scenario": "Two findings from different rule modules that were merged by exact dedup, then verified",
      "expected": "The verdict is carried on the canonical candidate id while every contributing instance id and source label is preserved"
    },
    {
      "id": 64,
      "clauses": [
        "C-6B"
      ],
      "scenario": "A high-impact finding is rejected in rollout-shadow and it is the only blocking candidate in the run",
      "expected": "The verdict still blocks the merge — a shadow-rejected finding keeps its severity and counts as a blocking candidate, so the observation window is not an unguarded window"
    },
    {
      "id": 65,
      "clauses": [
        "C-6B",
        "C-7"
      ],
      "scenario": "A report names candidate ids such as HR-2 when reporting a rebuttal",
      "expected": "The same report carries a mapping from each named candidate id to its finding; naming an id with no mapping forces the reader to guess which finding it was"
    },
    {
      "id": 66,
      "clauses": [
        "C-6B",
        "C-7"
      ],
      "scenario": "A run reports verification coverage without having executed prepare-verification.mjs",
      "expected": "The coverage line says the counts were not produced by the script, and the report does not describe the判정 as deterministic; hand-tallied numbers that happen to add up are still labelled as such"
    },
    {
      "id": 67,
      "clauses": [
        "C-6B"
      ],
      "scenario": "The same producer results are prepared twice, with the producers finishing in a different order the second time",
      "expected": "Every candidate keeps the same {ruleId}#{n} id both times — the ordinal follows normalized location, so a slow module does not renumber other findings"
    }
  ],
  "defaultWorkflowOnlyCases": [
    {
      "id": 39,
      "scenario": "--module fsd,type",
      "expected": "Only 01 and 02 run; the report states the filter and lists no other module as passing"
    },
    {
      "id": 40,
      "scenario": "--module 01,02,17",
      "expected": "Same selection by number"
    },
    {
      "id": 41,
      "scenario": "--module nope",
      "expected": "Review stops, names the unresolved token, lists available modules — it does not fall back to a full pass"
    },
    {
      "id": 42,
      "scenario": "--module 00",
      "expected": "Explains that common rules always apply, and asks whether a common-rules-only pass was intended"
    }
  ],
  "semanticPreservationCases": [
    {
      "id": "S-1",
      "workflow": "default",
      "scenario": "Legacy default review keeps the historical public Markdown contract while preserving prior semantics for the same findings",
      "preserves": {
        "findingCount": [
          "finding cardinality does not change when the renderer/skeleton changes"
        ],
        "wordingBody": [
          "issue wording and explanatory body survive without collapsing into a summary-only note"
        ],
        "axes": [
          "derived severity remains traceable to the same impact/confidence judgment even if the axes are not visibly printed"
        ],
        "ids": [
          "numbered rule IDs remain identical and distinguish repeated IDs with ordinal suffixes when needed"
        ],
        "sourceLabels": [
          "legacy general-pass findings still identify their producing module/report section consistently"
        ],
        "categoryMeanings": [
          "high-impact category meaning stays aligned with the five closed public labels"
        ],
        "recommendationEvidenceReason": [
          "recommendation/evidence/reason content is preserved instead of dropped or moved into raw JSON"
        ],
        "locations": [
          "verified/deleted/unverified location meaning and quoted anchor semantics stay intact"
        ],
        "openQuestions": [
          "unresolved search-scope items remain in the follow-up/open-question surface rather than becoming findings or disappearing"
        ]
      }
    },
    {
      "id": "S-2",
      "workflow": "full",
      "scenario": "Structured full review rendering preserves historical public report semantics across numbered and specialist passes",
      "preserves": {
        "findingCount": [
          "deduped rendered finding count matches the accepted producer findings count after valid aggregation only"
        ],
        "wordingBody": [
          "rendered findings keep module/specialist-specific body detail instead of flattening to headings or terse summaries"
        ],
        "axes": [
          "normalization preserves count/body/axes/IDs/source labels and impact/confidence survive into the rendered severity line without manual severity copy/raise"
        ],
        "ids": [
          "numbered, P-x, A/C-x, EX-x, and CR-x IDs remain stable and sortable in the final report"
        ],
        "sourceLabels": [
          "merged findings preserve every contributing source/pass label"
        ],
        "categoryMeanings": [
          "high-impact case enumerates exact category mappings: 사용자 오동작, 데이터 손상, 보안 노출, 검증 실패, 외부 계약 파손"
        ],
        "recommendationEvidenceReason": [
          "body/evidence/recommendation/confidence-reason/location-unverified-reason/open-question-reason fields render in their intended public slots exactly once"
        ],
        "locations": [
          "verified, deleted, and unverified locations render with the same semantic distinction as before, including verified/deleted ranges via endLine"
        ],
        "openQuestions": [
          "open questions remain a dedicated follow-up section and do not auto-merge with findings"
        ]
      }
    },
    {
      "id": "S-3",
      "workflow": "props/math/exception",
      "scenario": "Standalone specialist workflows validate producer JSON internally but still render their historical user-facing Markdown verdict/summary sections",
      "preserves": {
        "findingCount": [
          "standalone specialist reports preserve finding totals when switching internal validation format"
        ],
        "wordingBody": [
          "specialist-specific explanatory wording remains visible in Markdown rather than raw JSON output"
        ],
        "axes": [
          "impact/confidence semantics stay identical to prior standalone reports"
        ],
        "ids": [
          "P-x, A/C-x, and EX-x identifiers stay unchanged in public output"
        ],
        "sourceLabels": [
          "standalone reports preserve their pass identity and do not masquerade as generic JSON dumps"
        ],
        "categoryMeanings": [
          "high-impact category labels keep the same Korean public wording across specialist reports"
        ],
        "recommendationEvidenceReason": [
          "recommendation, evidence, and low-confidence or unverified reasons render into Markdown sections/rows"
        ],
        "locations": [
          "specialist reports preserve verified/deleted/unverified location semantics and quoting discipline"
        ],
        "openQuestions": [
          "follow-up investigation items remain in the public follow-up surface, not raw structured payloads"
        ]
      }
    }
  ]
}
```
<!-- WORKFLOW_FIXTURES_JSON:END -->

## Manual behavior scenarios

These remain manual because they depend on runtime LLM behaviour and report semantics rather than static prompt text.

| ID | Area | Scenario | Why manual |
|---|---|---|---|
| M-1 | corrective retry then failure | A structured producer returns malformed output, receives one corrective retry, and still returns malformed output | Static validation can confirm the documented policy, but not that the runtime will always follow the retry loop exactly once |
| M-2 | Markdown rendering safety | A valid structured producer result contains Markdown heading, fence, table, raw HTML, link syntax, code backticks inside `location.quote`, and a path/URL in prose | The validator can inspect contract tokens and fixtures, but it does not execute the orchestrator renderer or prove escaping |
| M-3 | semantic comparison limitation | Compare a representative old Markdown review against the new structured-result rendering for one general finding, one specialist finding, one unverified finding location, and one open question. Pass criteria: recommendation/evidence/reason fields all remain visible in their intended slots, verified/deleted ranges render with endLine semantics, openQuestions stay separated from findings, and public Markdown keeps verdict/summary/tool-result/follow-up meaning. | The repository can document this limitation, but static checks cannot prove semantic equivalence between old and new review runs |
