# Full Project Review Rule Contract

이 문서는 `/full-project-review` 전용 rule contract입니다. 일반 `/code-review` 모듈을 대체하지 않으며, 릴리스 전 전체 프로젝트를 같은 깊이로 훑는 절차가 아니라 **위험 기반으로 깊이를 배분하는 리뷰 계약**을 정의합니다.

리뷰 결과는 사용자가 다른 언어를 명시하지 않는 한 한국어로 작성합니다. 지적은 실제 프로젝트 증거에 연결하고, 선택한 영역과 제외한 영역을 숨기지 않습니다.

---

## Risk Targeting Method

### 1. Project inventory

리뷰 시작 시 저장소를 먼저 inventory 하여 프로젝트의 실행·배포·데이터 경계를 파악합니다. 최소한 아래 항목을 식별합니다.

- project type과 주요 runtime/framework
- `entrypoints`: application bootstrap, server start, CLI command, worker/job runner, scheduled task
- routes/commands/jobs: HTTP route, RPC/IPC channel, background job, queue consumer, webhook/event consumer
- build/test/deploy config: build script, test runner config, bundler config, container/orchestration config
- data stores와 `persistence`: database, cache, file/object storage, external state boundary
- `migrations`: schema/data migration, seed, rollout/backfill script
- `auth`: session, token, permission, role, tenant/user boundary, admin/user split
- `public APIs`: HTTP API, SDK/public export, IPC/event/webhook contract, config/env contract
- `secrets`: env key, credential path, token, private key, signing secret, secret-loading logic
- `package/lock files`: dependency manifest, lockfile, package manager config, runtime version pin
- `CI`와 `deployment`: workflow, release gate, container image, hosting/runtime config, rollback-sensitive deploy step
- critical tests/config: release-blocking smoke test, contract test, migration test, security-sensitive config test
- `payments` if present in the project

Inventory는 리뷰 대상을 고르는 입력입니다. inventory 자체가 모든 파일을 같은 깊이로 검토했다는 의미가 아니며, 각 항목은 실제 파일·경로·설정 증거와 연결되어야 합니다.

### 2. Risk selection criteria

Inventory 후 아래 기준으로 고위험 영역을 선택하고 깊이를 배분합니다.

- release impact: 배포 산출물, runtime startup, rollout/rollback에 직접 영향을 주는가
- user-facing blast radius: 사용자가 직접 겪는 주요 흐름, 장애 전파 범위, 핵심 화면/API에 닿는가
- security exposure: `auth`, `secrets`, permission boundary, tenant isolation, public ingress를 건드리는가
- data loss/corruption potential: `persistence`, 저장/삭제, write path, serialization, backup/restore, irreversible state 변경에 닿는가
- irreversible migration/deployment risk: `migrations`, backfill, schema change, deploy order, rollback 불가 변경이 있는가
- dependency boundary risk: `package/lock files`, public export, external API, generated client, runtime version 변경으로 경계를 깨는가
- recent/high-risk changes: 삭제, 이동, contract 변경, concurrency/idempotency 취약 흐름, large diff 또는 리뷰 이력이 불안한 영역인가
- low test confidence: 핵심 경로인데 검증 증거가 약하거나, 테스트가 범위를 직접 덮지 못하거나, 수동 확인만 남아 있는가
- operational criticality: job, queue, webhook, scheduler, deploy hook, monitoring/alerting, recovery path처럼 운영 실패 비용이 큰가

### 3. Required target classes

프로젝트에 존재하면 아래 target class는 반드시 inventory 하고, 위험 선택 여부를 Risk Index에 남깁니다.

- `entrypoints`
- `auth`
- `persistence`
- `migrations`
- `public APIs`
- `secrets`
- `deployment`
- `CI`
- `package/lock files`
- `payments` if present

선택되지 않은 required target도 숨기지 않습니다. 선택하지 않았다면 Risk Index의 `Exclusions`에 제외 사유와 근거를 기록합니다.

### 4. Exclusions and override

기본적으로 generated, vendored, binary, minified artifacts는 리뷰 깊이 대상에서 제외합니다.

- generated: generated client, generated schema/type, build output, compiled artifact
- vendored: third-party source copied into repository, dependency cache, external template snapshot
- binary: image, archive, executable, model/blob, database dump 같은 사람이 읽는 diff 검토에 부적합한 파일
- minified: `.min.*`, bundled/minified JS/CSS, sourcemap 없는 압축 산출물

단, release impact 또는 direct evidence 때문에 위험 영역으로 선택된 경우에는 예외적으로 targeted review를 수행합니다. 예: generated API client가 public contract를 바꾸는 유일한 증거이거나, minified artifact가 실제 배포 산출물로 커밋되어 release behavior를 결정하는 경우.

Exclusion은 항상 Risk Index에 드러나야 합니다. 제외한 영역을 단순히 생략하거나, 제외 사실을 숨긴 채 전체 검토 완료처럼 표현하면 안 됩니다.

---

## Risk Index

`/full-project-review` 보고서는 본문 앞부분에 Risk Index table을 포함해야 합니다.

| Area | Why Selected | Evidence | Depth | Exclusions |
|------|--------------|----------|-------|------------|
| 예: auth/session boundary | public ingress와 permission boundary에 직접 영향 | `src/auth/*`, route middleware, env config | deep | generated token docs excluded unless direct evidence appears |

Column 이름은 정확히 `Area`, `Why Selected`, `Evidence`, `Depth`, `Exclusions`를 사용합니다.

- `Area`: inventory에서 식별한 영역 또는 target class
- `Why Selected`: 위험 선택 기준 중 어떤 이유로 선택했는지
- `Evidence`: 실제 파일, 설정, diff, command output, dependency, route/job 이름 같은 검증 가능한 증거
- `Depth`: deep / targeted / shallow / excluded 중 하나로 리뷰 깊이를 표시
- `Exclusions`: 제외한 파일군, 제외 이유, override 조건이 있었는지

Risk Index는 리뷰 범위의 계약입니다. 보고서는 이 table을 근거로 어떤 영역을 깊게 보았고 어떤 영역을 제외했는지 설명해야 합니다.

---

## Coverage Claim Boundary

`/full-project-review`는 risk-based coverage입니다. 보고서와 최종 응답은 모든 파일을 동일 깊이로 검토했다거나 exhaustive equal-depth review를 수행했다고 주장하면 안 됩니다.

허용되는 표현:

- Risk Index에 따라 고위험 영역을 deep/targeted review 했다.
- generated/vendor/binary/minified artifacts는 명시한 override 조건이 없으면 제외했다.
- 제외와 얕은 검토 영역은 Risk Index에 공개했다.

금지되는 표현:

- 모든 파일을 같은 깊이로 완전 검토했다는 주장
- 제외 영역을 숨기는 완료 선언
- inventory만 수행하고 위험 선택 증거 없이 전체 프로젝트 안전을 보증하는 표현

---

## Severity Normalization

`/full-project-review` findings use the normalized severities below when mapping project evidence to the final release-gate verdict. Module-local labels such as ERROR/WARNING/INFO must be translated into this schema before deciding PASS, WARN, or BLOCK.

| Severity | Definition | Verdict behavior |
|----------|------------|------------------|
| Critical | Narrow release-gate defect with evidence of exploitable security exposure, data loss/corruption, release-breaking runtime failure, broken core release path, destructive behavior, irreversible migration/deployment risk, or similarly severe project-level harm. Examples include unsafe auth or secret exposure, duplicate externally visible side effects that can corrupt data, replay-unsafe mutation/payment paths, migration/deploy steps that cannot be safely rolled back, or API/contract breakage that makes a core release path fail at runtime. | May produce `Verdict: BLOCK` for project defects. |
| High | Serious risk requiring prioritized follow-up, such as compatibility, concurrency, operational, or security-sensitive weakness with plausible release impact, but without enough evidence to meet the Critical criteria. | Produces WARN/TODO unless it is escalated to Critical by concrete evidence. |
| Medium | Meaningful maintainability, correctness, testing, UX, or operational issue that should be addressed but does not block release. | Produces WARN/TODO. |
| Low | Minor issue, cleanup, small inconsistency, localized low-risk concern, or polish item. | Produces WARN/TODO or may be listed as follow-up context. |
| Info | Observation, limitation, evidence note, non-actionable context, or explanation of reviewed/excluded scope. | Does not require remediation by itself. |

Only Critical defects can produce Verdict: BLOCK for project defects.

High/Medium/Low findings must not block release by themselves. Info findings must not block release by themselves.

### Verdict conditions

- `PASS`: The review completed meaningfully, Risk Index coverage and exclusions are disclosed, required target classes were considered, and no release risks are found.
- `WARN`: Non-Critical findings exist, or the review is degraded but still usable because evidence, agent output, and command results are sufficient to support a meaningful release-gate assessment. High, Medium, Low, and Info findings remain WARN/TODO unless they meet the Critical definition.
- `BLOCK`: At least one Critical project defect is supported by concrete evidence, or the result is `BLOCK: Orchestration Failure`.

### BLOCK: Orchestration Failure

`BLOCK: Orchestration Failure` is separate from project defects. Use it when the review cannot perform a meaningful release-gate assessment because required evidence is missing, review agents fail, required commands are unavailable, command timeouts prevent coverage, or the Risk Index / required target coverage is incomplete enough that the result would be misleading.

Do not label orchestration failures as Critical code defects. Conversely, do not downgrade a Critical project defect into orchestration failure when concrete project evidence shows release-blocking harm.

---

## BLOCK Fix Plan

Generate a BLOCK fix plan only when the final review result is `Verdict: BLOCK`.

`Verdict: PASS` and `Verdict: WARN` do not get BLOCK fix plans. They may include prioritized TODOs, follow-ups, or release notes, but those items must not be presented as a BLOCK fix plan.

The BLOCK fix plan is part of the review result by default. Print or report it in the final review output so the user can decide what to do next.

Writing a fix plan to `.sisyphus/plans/*.md` requires an explicit runtime or user request after the review. Do not create, append to, or modify `.sisyphus/plans/*.md` as the default review behavior.

### Required schema

When a BLOCK fix plan is generated, include these fields literally and in this order:

1. `Critical finding summary`: concise description of each release-blocking Critical defect or BLOCK orchestration condition.
2. `Evidence`: file paths, command output, agent output, reproduction notes, or other concrete proof supporting the BLOCK verdict.
3. `Affected files/areas`: files, directories, commands, routes, jobs, configs, data stores, deployment steps, or runtime boundaries likely touched by remediation.
4. `Ordered remediation tasks`: smallest safe task sequence for fixing or unblocking the review, with dependency order made explicit.
5. `Verification commands`: commands or manual checks that must pass before the BLOCK can be cleared.
6. `Rollback notes`: safe revert, backup, deployment, migration, or recovery notes relevant to the remediation.
7. `Done when`: concrete exit criteria for clearing the BLOCK verdict.

### Mutation boundary

No auto-fix. The review must not apply the BLOCK fix plan automatically.

Do not auto-format, auto-commit, publish, upgrade dependencies, or modify application code while generating the review result or the BLOCK fix plan.

The fix plan describes what should happen next. It does not authorize the reviewer to perform those changes unless a separate post-review request explicitly asks for implementation or plan-file creation.
