---
name: code-review
description: Use when the user asks to review code, invokes /code-review, before merging branches, or after completing a feature. Runs a bounded default modular code review pass; use /code-review-full for exhaustive multi-pass coverage.
---

# Multi-Pass Code Review

모듈러 코드 리뷰 시스템. `~/.claude/review-rules/` 폴더에서 **숫자 prefix가 붙은 `.md` 파일**(`00-rule.md` through `12-deletion-regression.md`)만 리뷰 모듈로 사용한다. 기본 `/code-review`는 안전한 bounded 전략으로 단일 통합 리뷰 pass를 수행한다. 상세하고 exhaustive한 모듈별 multi-pass coverage가 필요하면 `/code-review-full`을 사용한다.

`00-rule.md`는 모든 리뷰 모듈보다 먼저 읽고 우선 적용하는 최상위 공통 규칙이다. 개별 모듈과 충돌하면 `00-rule.md` 기준을 따른다.

## 리뷰 규칙 위치

`~/.claude/review-rules/` — 숫자 prefix가 붙은 `.md` 파일만 모듈로 간주. 파일명 앞 숫자는 실행 순서, `00-rule.md`가 항상 최우선이다.

**자동 모듈 스캔에서 제외되는 파일**: 숫자 prefix가 없는 파일(예: `fast.md`, `math.md`)은 특수 워크플로우(`/code-review-fast`, `/code-review-math`) 전용이며, 일반 `/code-review`에서는 절대 로드하지 않는다.

## 실행 절차

### Step 1: Diff 범위 결정

```bash
# base 브랜치 결정 (기본: dev)
BASE_BRANCH=dev
MERGE_BASE=$(git merge-base $BASE_BRANCH HEAD)
echo "Review range: $MERGE_BASE..HEAD"

# 변경된 파일 목록
git diff --stat $MERGE_BASE..HEAD

# 실제 diff
git diff $MERGE_BASE..HEAD
```

사용자가 특정 범위를 지정하면 그것을 사용. 지정하지 않으면 기본적으로 `dev` 브랜치를 기준으로 범위를 계산한다.

리뷰 대상에서 아래 테스트/목 관련 경로는 제외한다. diff 확인 시 존재 여부를 볼 수는 있지만, sub-agent에 전달하는 변경 파일 목록과 리뷰 지적 범위에서는 제거한다.

- `__test__/**`, `__tests__/**`
- `*.test.*`, `*.spec.*`
- `__mocks__/**`, `mock/**`, `mocks/**`
- `*.mock.*`, `mockData/**`, `fixtures/**` 처럼 테스트/목 전용 자산임이 명확한 파일/폴더

### Step 2: Lint 확인 및 자동 수정

리뷰 시작 전 저장소의 lint 명령을 먼저 확인한다.

- `package.json`, lint config, CI/workflow 파일에서 실제 lint 명령을 찾는다
- `lint:fix` 같은 자동 수정 스크립트가 있으면 먼저 실행한다
- 별도 `lint:fix`가 없어도 ESLint 기반이면 기존 lint 명령에 `--fix`를 붙인 동등 명령을 사용해 자동 수정 가능한 문제를 먼저 정리한다
- 자동 수정 후에는 lint를 다시 실행해 남은 오류를 확인한다
- 자동 수정으로 해결된 문제는 리뷰 이슈로 장황하게 반복하지 말고, 남은 위반이나 구조적 문제에 집중한다
- If the user requested read-only review or said not to modify files, MUST NOT run auto-fix commands. In that case, run lint/check commands only and report fixable findings.

### Step 3: 리뷰 모듈 목록 확인

```bash
ls ~/.claude/review-rules/[0-9]*.md
```

**숫자 prefix가 붙은 파일만** 리뷰 패스(pass)로 사용. `fast.md`, `math.md` 같은 특수 워크플로우 전용 문서는 이 스캔에서 제외된다.

`00-rule.md` is loaded as common rules for every module. Do not treat `00-rule.md` as a normal review module unless the user explicitly requests a common-rule-only pass. Numbered non-00 modules remain review modules, but default `/code-review` evaluates them through one consolidated bounded pass instead of per-module fan-out.

### Step 4: 안전한 bounded Sub-Agent Dispatch

기본 `/code-review`는 **단일 통합 리뷰**를 수행한다. 숫자 prefix가 붙은 non-00 리뷰 모듈 전체와 `00-rule.md` 공통 규칙을 하나의 sub-agent prompt에 포함하고, `run_in_background=false`로 즉시 실행한다. 이 bounded 기본 경로는 agent 폭증과 timeout 위험을 줄이기 위한 safe default이다.

상세하고 exhaustive한 모듈별 multi-pass coverage가 필요하면 기본 `/code-review`를 확장하지 말고 `/code-review-full`을 사용한다.

```
task(
  category="unspecified-high",
  load_skills=[],
  run_in_background=false,
  description="Code Review (bounded consolidated pass)",
  prompt="아래 지시에 따라 코드 리뷰를 수행하세요.

## 리뷰 대상
- 기준: {MERGE_BASE}
- 대상: HEAD
- 변경 파일: {CHANGED_FILES}
- 제외 파일: `__test__/**`, `__tests__/**`, `*.test.*`, `*.spec.*`, `__mocks__/**`, `mock/**`, `mocks/**`, `*.mock.*`, 테스트/목 전용 fixture/mock data

## 리뷰 수행 방법
1. `git diff {MERGE_BASE}..HEAD` 로 전체 diff를 확인하세요
2. 변경된 파일들을 직접 읽어서 컨텍스트를 파악하세요
3. `00-rule.md` 공통 규칙을 모든 모듈보다 우선 적용하세요
4. 아래 numbered non-00 리뷰 모듈들을 모듈 순서대로 검토하세요
5. 아래 리뷰 규칙에 따라 위반 사항을 찾으세요
6. 위반이 없는 규칙은 출력하지 마세요
7. 동작 여부만 보지 말고, 문제 정의·의도·선택 근거·장기 변경 비용까지 함께 검토하세요
8. 파일 전체를 읽더라도 **지적은 diff에 포함된 변경 라인** 또는 그 변경 때문에 직접 깨진 **인접 라인/구조**로 제한하세요

## 공통 리뷰 규칙
{COMMON_RULES_CONTENT — 00-rule.md 전체 내용}

## 모듈 리뷰 규칙
{MODULE_RULES_CONTENT — numbered non-00 모듈 .md 파일 전체 내용, 모듈 순서 유지}

00-rule.md와 모듈 규칙이 충돌하면 00-rule.md를 우선 적용하세요.
Rule IDs in findings MUST include the module prefix, for example `01-3`, `11-2`, `12-1`, or `EX-1`.

## 출력 형식
위반 사항만 아래 형식으로 출력하세요. 위반이 없으면 '위반 없음'만 출력.
사용자가 다른 언어를 명시하지 않은 한 모든 리뷰 결과/코멘트/리포트는 한국어로 작성하세요.
가능하면 각 이슈는 **문제 → 현재 선택 → 왜 부족한지**가 드러나게 쓰세요.

### [모듈명]

| 심각도 | 규칙 | 위치 | 이슈 | 개선 제안 |
|----------|------|------|------|----------|
| 🔴/🟡/🔵 | 규칙번호 | 파일:라인 | 구체적 위반(문제/현재 선택/부족한 이유 포함) | 수정 방향 |

## 금지 사항
- diff에 포함되지 않은 기존 코드를 지적하지 마세요
- 파일 전체를 읽었다는 이유로 리뷰 범위를 파일 전체로 넓히지 마세요
- 제외 파일(`__test__`, `__tests__`, test/spec 파일, mock/mocks/fixture 전용 파일)은 리뷰 이슈로 지적하지 마세요
- 추측으로 지적하지 마세요 — 실제 코드를 읽고 확인하세요
- 위반이 아닌 것을 억지로 찾지 마세요"
)
```

**중요**: 기본 `/code-review`는 bounded 단일 통합 pass로 완료한다. bounded pass가 실패하거나 timeout되면 완료로 표시하지 말고, 어떤 범위가 성공/실패/미확인인지 최종 리포트에 정직하게 기록한다.

### Step 5: 결과 수집 및 통합

bounded pass 완료 후:

1. sub-agent 결과를 확인한다
2. 결과를 severity 순서로 병합: 🔴 ERROR → 🟡 WARNING → 🔵 INFO
3. 같은 severity 내에서는 모듈 순서대로 정렬
4. 위반 없는 모듈은 최하단에 "✅ 통과" 로 요약

### Step 6: 최종 리포트 출력

```markdown
# 코드 리뷰 리포트

> **기준**: {MERGE_BASE} | **대상**: HEAD | **리뷰 시각**: {TIMESTAMP}
> **변경 파일**: {N}개 | **리뷰 모듈**: {M}개

## 🔴 ERROR (머지 전 수정 필수)

| 모듈 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| ... | ... | ... | ... | ... |

## 🟡 WARNING (수정 권장)

| 모듈 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| ... | ... | ... | ... | ... |

## 🔵 INFO (개선 제안)

| 모듈 | 규칙 | 위치 | 이슈 | 개선 제안 |
|--------|------|------|------|----------|
| ... | ... | ... | ... | ... |

## 요약

| 모듈 | 🔴 | 🟡 | 🔵 | 결과 |
|------|-----|-----|-----|------|
| FSD 아키텍처 | 0 | 1 | 0 | ⚠️ |
| 타입 안전성 | 0 | 0 | 0 | ✅ |
| ... | ... | ... | ... | ... |

**머지 가능 여부**: 🔴 {N}개 → {가능/불가/수정 후 가능}
```

최종 리포트는 기본적으로 `.md` 파일로 저장한다. 단, 사용자가 파일 생성/수정을 금지했거나 텍스트 응답만 요청한 경우에는 저장하지 않는다. 저장 경로는 `./review-reports/code-review-{branch-name}-{date}.md`를 우선 사용하고, 저장 경로를 함께 보고한다. 문서 내용은 **이번 브랜치 diff와 실제 변경 파일 기준**으로 작성하고, 저장소 전체 일반론이나 diff 밖의 장황한 설명은 피한다. 기존 리뷰 문서가 이미 있어도 그 문서를 이유로 리뷰를 건너뛰지 말고 **항상 새 리뷰를 수행한 뒤 새 파일로 저장**한다. 이 워크플로우의 `workflow-name`은 `default`이다.

## 사용법

```
/code-review                    — 현재 브랜치 전체 리뷰
/code-review main..feature/x    — 특정 범위 리뷰
/code-review --module fsd,type  — 특정 모듈만 리뷰
/code-review-full               — 상세/exhaustive 모듈별 multi-pass 리뷰
```

## 주의사항

- 기본 `/code-review`는 safe default로 bounded 단일 통합 리뷰를 사용한다
- 상세/exhaustive 모듈별 multi-pass coverage가 필요하면 `/code-review-full`을 사용한다
- diff에 포함되지 않은 기존 코드는 리뷰 대상이 아니다
- `__test__`, `__tests__`, test/spec 파일, mock/mocks/fixture 전용 파일은 일반 `/code-review` 대상이 아니다
- 리뷰 규칙 파일 추가/삭제만으로 리뷰 범위를 조절할 수 있다
- 빈 diff (변경 없음)이면 리뷰를 수행하지 않는다
- lint는 리뷰 전에 먼저 확인하고, 자동 수정 가능한 항목은 선반영한 뒤 남은 문제만 리뷰한다
