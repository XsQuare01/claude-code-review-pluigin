---
name: code-review-props
description: Use when the user invokes /code-review-props or wants a standalone review focused on props drilling, excessive props, handler tunneling, or too many function arguments. Excluded from the default /code-review.
---

# Props & Arguments Code Review

Props drilling, 과도한 props 전달, 함수 인자 과다를 **독립적으로** 검토하는 전용 리뷰 모드. 일반 코드 품질·아키텍처 검사와는 분리된 특수 리뷰이며, 일반 `/code-review`에서는 자동 제외된다.

## 공통 계약

`RULES_DIR` 해석, 범위 결정, 제외 경로, 실행 안전, 리포트 저장, 실패 보고는 **`$RULES_DIR/workflow-contract.md`** 를 따른다. 아래는 이 워크플로우의 차이다.

| 항목 | 이 워크플로우 |
|------|---------------|
| `workflow-name` | `props` |
| 모듈 집합 | `$RULES_DIR/props.md` 단일 문서 (숫자 prefix 모듈·다른 특수 문서 미로드) |
| 규칙 ID | `P-{n}` |
| 범위 없음 | `SKIPPED`로 기록 (C-8) |

일반 리뷰가 필요하면 `/code-review` 또는 `/code-review-fast`를 별도로 실행한다.

## 검사 범위

- props drilling 3단계 이상
- 중간 컴포넌트가 값을 사용하지 않고 그대로 넘기는 pass-through 구조
- 컴포넌트 props 개수 과다 및 boolean props 조합 폭발
- 함수/훅/서비스 인자 4개 초과, boolean/optional 인자로 호출부 의미가 흐려지는 구조
- setter, dispatch, mutation handler가 leaf 컴포넌트까지 전달되는 구조
- props drilling 해결책으로 context/store를 과하게 쓰는 경우

## 실행 절차

### Step 1: Diff 범위 결정

범위 결정은 `workflow-contract.md` C-4를 따른다. 결정된 범위로 `git diff --stat $MERGE_BASE..HEAD`와 `git diff $MERGE_BASE..HEAD`를 확인한다. 제외 경로는 C-5를 따른다.

변경 파일 중 컴포넌트, 훅, 함수 시그니처, 서비스/API 호출, 상태 전달 구조가 바뀐 파일만 리뷰 대상으로 좁힌다. 관련 변경이 없으면 "대상 없음"으로 종료한다.

### Step 2: Lint 확인 (read-only, 선택)

`00-rule.md` 00-9 실행 안전 계약을 따른다. lint가 설정돼 있으면 **수정 옵션 없이** 실행하고, 자동 수정은 사용자가 명시적으로 요청했을 때만 한다. props/인자 구조 리뷰는 lint와 별도 축이므로 lint가 없어도 그대로 진행 가능하다.

### Step 3: 단일 Sub-Agent Dispatch

**단 하나의 sub-agent**만 dispatch한다. `run_in_background=false`로 즉시 실행.

```
task(
  category="unspecified-high",
  load_skills=[],
  description="Props & Arguments Code Review",
  prompt="아래 지시에 따라 props drilling 및 인자 전달 구조 코드 리뷰를 수행하세요.

## 리뷰 대상
- 기준: {MERGE_BASE}
- 대상: HEAD
- 변경 파일 (props/인자 전달 구조 관련 파일만): {CHANGED_PROP_FILES}

## 리뷰 수행 방법
1. `git diff {MERGE_BASE}..HEAD` 로 전체 diff 확인
2. 변경 파일을 직접 읽어서 컴포넌트 트리, props 전달 체인, 함수 호출 체인을 추적
3. 아래 리뷰 규칙 전체를 적용해 위반 사항 탐지
4. props 이름만 보고 추측하지 말고 실제로 어느 컴포넌트/함수를 거쳐 전달되는지 확인
5. 단순 개수보다 책임 혼재, pass-through, 호출부 의미 불명확성을 우선 판단

## 리뷰 규칙
아래 파일을 먼저 Read 한 뒤 그 규칙을 기반으로 리뷰하세요:
- `{RULES_DIR}/props.md`

이 문서 하나만 사용합니다. 같은 폴더의 숫자 prefix 모듈과 `fast.md`, `math.md`, `exception.md`는 참조하지 마세요.

## 출력 원칙
- 사용자가 다른 언어를 명시하지 않은 한 모든 리뷰 결과/코멘트/리포트는 한국어로 작성하세요.
- severity 우선순위: 🔴 > 🟡 > 🔵
- 위치(파일:line)와 규칙 번호(P-x)를 반드시 표기
- 위치는 **해당 파일을 읽어 확인한 변경 후 줄 번호**를 적고, 그 줄의 코드를 한 줄 인용하세요. diff hunk 헤더(`@@`)에서 계산한 번호는 어긋납니다. 확인이 안 되면 번호를 추측하지 말고 `위치 미확인`으로 적으세요
- 리포트의 섹션 이름·순서·헤딩 레벨은 `workflow-contract.md` C-7 **문서 골격**을 따르세요. 골격 표에 없는 섹션을 새로 만들지 마세요
- diff에 없는 기존 props/인자 구조는 지적 금지
- 전체 파일을 읽더라도 지적은 diff 변경 라인 또는 그 변경 때문에 직접 깨진 인접 구조로 제한
- 추측 금지 — 의심스러우면 '검증 필요'로 표기
- 이슈 없으면 '위반 없음'만 출력

## 출력 형식 (마크다운)

# Props/인자 전달 코드 리뷰 리포트

> **기준**: {MERGE_BASE} | **대상**: HEAD
> **검사 파일**: {N}개 (props/인자 전달 구조 변경)

## 한눈에 보기
- 🔴: N개 / 🟡: N개 / 🔵: N개

## 위반 목록

| 심각도 | 파일 | 위치 | 규칙 | 이슈 | 개선 방향 |
|----------|------|------|------|------|----------|
| 🔴 | path/to/file | L123 | P-1 | ... | ... |
| 🟡 | path/to/file | L45 | P-4 | ... | ... |

## 통과
- (이슈 없는 파일 리스트, 또는 '전부 통과' 요약)

**머지 가능 여부**: 🔴 {N}개 → {가능/불가/수정 후 가능}"
)
```

### Step 4: 결과 전달

sub-agent의 출력을 그대로 사용자에게 전달한다. 명백한 형식 오류만 짧게 보정한다.

### Step 5: 문서 저장

리포트 저장은 `workflow-contract.md` C-7을 따른다 (`workflow-name`은 `props`). 문서 내용은 **이번 브랜치 diff 안에서 props/인자 전달 구조가 바뀐 파일과 그 구조적 이슈** 중심으로 쓴다.

## 사용법

```
/code-review-props                    — 현재 브랜치의 props drilling / 인자 전달 구조 리뷰
/code-review-props main..feature/x    — 특정 범위 리뷰
```

## 주의사항

- 이 모드는 일반 코드 품질·아키텍처를 검사하지 않는다. 그쪽은 `/code-review` 또는 `/code-review-fast`로 별도 실행
- 변경 파일에 props/인자 전달 구조 변경이 없으면 "대상 없음"으로 즉시 종료
- `props.md`는 숫자 prefix가 없어 `/code-review`의 자동 모듈 스캔에서 제외됨
- props drilling 해결책으로 context/store를 제안할 때도 과한 전역화인지 함께 검토한다
