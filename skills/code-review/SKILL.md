---
name: code-review
description: Use when the user asks to review code, invokes /code-review, before merging branches, or after completing a feature. Runs a bounded default modular code review pass; use /code-review-full for exhaustive multi-pass coverage.
---

# Multi-Pass Code Review

React 전용 모듈러 코드 리뷰 시스템. 리뷰 규칙 폴더에서 **숫자 prefix가 붙은 `.md` 파일 전체**를 리뷰 모듈로 사용한다. 기본 `/code-review`는 안전한 bounded 전략으로 단일 통합 리뷰 pass를 수행한다. 상세하고 exhaustive한 모듈별 multi-pass coverage가 필요하면 `/code-review-full`을 사용한다.

`00-rule.md`는 모든 리뷰 모듈보다 먼저 읽고 우선 적용하는 최상위 공통 규칙이다. 개별 모듈과 충돌하면 `00-rule.md` 기준을 따른다.

## 공통 계약

`RULES_DIR` 해석, 모듈 탐색, 적용 조건 판정, 범위 결정, 제외 경로, 실행 안전, 리포트 저장, 실패 보고는 **`$RULES_DIR/workflow-contract.md`** 를 따른다. 이 문서는 그 계약을 복제하지 않고, 아래 "이 워크플로우의 차이"만 선언한다.

리뷰를 시작하기 전에 `workflow-contract.md`를 먼저 읽는다.

### 이 워크플로우의 차이

| 항목 | 이 워크플로우 |
|------|---------------|
| `workflow-name` | `default` |
| 모듈 집합 | numbered non-00 전체 (`--module` 필터 적용 가능) |
| 분할 방식 | 단일 통합 bounded pass (모듈별 fan-out 없음) |
| 출력 밀도 | 발견된 위반 전부 |

## 실행 절차

### Step 1: Diff 범위 결정

`workflow-contract.md` C-4를 따른다. 결정된 범위로 아래를 확인한다.

```bash
git diff --stat $MERGE_BASE..HEAD
git diff $MERGE_BASE..HEAD
```

제외 경로는 C-5를 따른다.

### Step 2: Lint 확인 (read-only)

`00-rule.md` 00-9 실행 안전 계약을 따른다. **자동 수정은 실행하지 않는다.**

- `package.json`, lint config, CI/workflow 파일에서 실제 lint 명령을 찾는다
- lint를 **수정 옵션 없이** 실행한다 (`--fix`, `--write` 금지)
- 자동 수정으로 해결 가능한 항목은 실행하지 말고 개수와 성격만 기록해, 최종 리포트의 `## 도구 실행 결과` 섹션에 적는다
- lint가 이미 잡는 항목은 리뷰 지적으로 중복해서 나열하지 않고, 구조적 문제에 집중한다
- 사용자가 명시적으로 자동 수정을 요청한 경우에만 `lint:fix` 계열을 실행하고, 무엇을 고쳤는지 리포트에 남긴다

### Step 3: 리뷰 모듈 목록 확인

```bash
ls "$RULES_DIR"/[0-9]*.md
```

모듈 탐색과 `00-rule.md` 취급은 `workflow-contract.md` C-2를, 모듈별 적용 조건(FSD·Tailwind·RSC·SSR·React 버전 등) 판정은 C-3을 따른다. 전제가 성립하지 않는 모듈은 `SKIPPED`와 사유를 남기고, 조용히 빼지 않는다.

기본 `/code-review`는 numbered non-00 모듈을 **하나의 통합 bounded pass**로 평가한다 (모듈별 fan-out은 `/code-review-full`).

#### `--module` 필터

`--module` 인자가 주어지면 위에서 나열한 모듈 중 **선택된 것만** 리뷰 대상으로 삼는다. 인자가 없으면 non-00 모듈 전체를 사용한다.

**토큰 매핑**: 각 모듈 파일 `NN-slug.md`는 세 가지 토큰으로 지정할 수 있다. 매핑은 파일명에서 그때그때 유도하며, 목록을 하드코딩하지 않는다.

| 토큰 형태 | 예시 | 대상 |
|-----------|------|------|
| 번호 | `03` | `03-react-rules.md` |
| slug | `react-rules` | `03-react-rules.md` |
| slug 접두 일치 (유일할 때) | `react` | `03-react-rules.md` |
| 전체 이름 | `03-react-rules` | `03-react-rules.md` |

- 구분자는 쉼표이며 공백은 무시한다: `--module fsd, type` == `--module fsd,type`
- 대소문자를 구분하지 않는다
- `.md` 확장자를 붙여도 받아들인다

**해석 실패 처리** — 리뷰를 임의로 진행하지 않고 중단한 뒤 사용자에게 알린다.

- 어느 모듈과도 매칭되지 않는 토큰: 그 토큰을 명시하고, 사용 가능한 모듈 목록(번호 + slug)을 함께 출력한다
- 접두 일치가 여러 모듈에 걸리는 토큰(예: 모듈이 늘어 `perf`가 둘 이상에 맞는 경우): 후보를 나열하고 더 구체적인 토큰을 요청한다
- `00`을 지정한 경우: `00-rule.md`는 공통 규칙이라 항상 적용된다고 알리고, 나머지 선택으로 진행한다. 선택이 `00` 뿐이면 공통 규칙만 검토하는 pass인지 되묻는다
- 결과 선택이 비면 전체 리뷰로 조용히 넘어가지 않는다

**선택 결과 반영**

- Step 4의 `{MODULE_RULES_CONTENT}`에는 **선택된 모듈만** 넣는다
- `00-rule.md` 공통 규칙은 선택과 무관하게 항상 포함한다
- 최종 리포트 헤더의 `리뷰 모듈` 개수와 요약 표에는 선택된 모듈만 나열하고, 필터가 적용됐다는 사실과 선택 목록을 리포트 상단에 명시한다. 검토하지 않은 모듈을 "✅ 통과"로 표시하지 않는다

### Step 4: 안전한 bounded Sub-Agent Dispatch

기본 `/code-review`는 **단일 통합 리뷰**를 수행한다. Step 3에서 선택된 non-00 리뷰 모듈(필터가 없으면 전체)과 `00-rule.md` 공통 규칙을 하나의 sub-agent prompt에 포함하고, `run_in_background=false`로 즉시 실행한다. 이 bounded 기본 경로는 agent 폭증과 timeout 위험을 줄이기 위한 safe default이다.

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
{MODULE_RULES_CONTENT — Step 3에서 선택된 non-00 모듈 .md 파일 전체 내용, 모듈 순서 유지}

00-rule.md와 모듈 규칙이 충돌하면 00-rule.md를 우선 적용하세요.
규칙 ID는 `00-rule.md` 00-2 표기 규칙을 그대로 따르세요. 숫자 모듈은 파일 prefix와 동일한 `{파일번호}-{규칙번호}` 형식(`01-3`, `03-1`, `19-2`, `20-4`), 개발 원칙은 `10-{원칙 약어}`(`10-SSOT`) 형식입니다. 이 pass에서는 `EX-`, `P-`, `A-`, `C-` 계열 ID를 사용하지 마세요 — 해당 모듈은 여기서 로드되지 않습니다.

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
> **모듈 필터**: {선택된 모듈 목록 — `--module`이 없으면 이 줄을 생략}

## 도구 실행 결과

| 명령 | 결과 | 비고 |
|------|------|------|
| ... | ... | 자동 수정 가능 항목은 실행하지 않고 개수만 기록 |

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

리포트 저장은 `workflow-contract.md` C-7을 따른다 (`workflow-name`은 `default`). 문서 내용은 **이번 브랜치 diff와 실제 변경 파일 기준**으로 작성하고, 저장소 전체 일반론이나 diff 밖의 장황한 설명은 피한다.

## 사용법

```
/code-review                    — 현재 브랜치 전체 리뷰
/code-review main..feature/x    — 특정 범위 리뷰
/code-review --module fsd,type  — 특정 모듈만 리뷰 (slug)
/code-review --module 01,02,17  — 특정 모듈만 리뷰 (번호)
/code-review-full               — 상세/exhaustive 모듈별 multi-pass 리뷰
```

`--module` 토큰 해석과 실패 처리는 Step 3의 `--module 필터`를 따른다. 범위 지정과 `--module`은 함께 쓸 수 있다.

## 주의사항

- 기본 `/code-review`는 safe default로 bounded 단일 통합 리뷰를 사용한다
- 상세/exhaustive 모듈별 multi-pass coverage가 필요하면 `/code-review-full`을 사용한다
- diff에 포함되지 않은 기존 코드는 리뷰 대상이 아니다
- 리뷰 규칙 파일 추가/삭제만으로 리뷰 범위를 조절할 수 있다
- 나머지 실행 규칙(제외 경로, 빈 diff, read-only, 리포트 저장)은 `workflow-contract.md`를 따른다
