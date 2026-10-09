---
name: code-review-fast
description: Use when the user wants a faster, shorter code review that highlights only the most important issue per file. Uses a single compressed rule document and a single sub-agent for minimum latency.
---

# Fast Code Review

짧고 빠른 코드 리뷰 모드. `/code-review`와 달리 **압축된 단일 룰 문서(`fast.md`)** 를 기반으로 **단일 sub-agent** 가 한 번에 전체를 검토한다. 숫자 prefix 상세 모듈을 전혀 로드하지 않아 sub-agent 오버헤드와 tail latency를 제거한 저지연 경로이며, 큐 포화(queue saturation), tail latency, timeout 위험이 우려될 때 적합하다.

## 핵심 원칙

1. 단일 룰 문서를 읽고, **출력은 high-signal만** 남긴다
2. 같은 파일에서 여러 이슈가 보여도 **가장 중요한 것 1개만** 남긴다
3. 사소한 스타일, 중복 설명, 비슷한 지적 반복은 버린다
4. 리뷰 결과는 **짧게**, 보통 파일당 1줄~2줄 수준으로 끝낸다

## 공통 계약

`RULES_DIR` 해석, 범위 결정, 제외 경로, 실행 안전, 리포트 저장, 실행 타임라인(C-9), 실패 보고는 **`$RULES_DIR/workflow-contract.md`** 를 따른다. 아래는 이 워크플로우의 차이다.

| 항목 | 이 워크플로우 |
|------|---------------|
| `workflow-name` | `fast` |
| 모듈 집합 | `$RULES_DIR/fast.md` 단일 문서 (숫자 prefix 상세 모듈 미로드) |
| 분할 방식 | 단일 sub-agent |
| 출력 밀도 | 파일당 최대 1개 |

이 워크플로우는 **legacy producer workflow**다. `workflow-contract.md`의 ownership matrix에서 legacy로 유지되며, C-6A의 structured lifecycle은 여기 적용하지 않는다. 기존 producer 계약을 유지한다.

`fast.md` 안의 섹션별 적용 조건(RSC·Tailwind·SSR·React 19·서버 코드·contract 제공자 등)은 계약 C-3과 같은 기준으로 판정한다. 조건이 성립하지 않는 섹션은 적용하지 않는다.

상세/포괄적 리뷰가 필요하면 `/code-review-full`을 쓴다.

## 실행 절차

### Step 1: Diff 범위 결정

범위 결정은 `workflow-contract.md` C-4를 따른다. 결정된 범위로 `git diff --stat $MERGE_BASE..HEAD`와 `git diff $MERGE_BASE..HEAD`를 확인한다. 제외 경로는 C-5를 따른다.

**diff는 여기서 오케스트레이터가 한 번만 수집한다.** `git diff $MERGE_BASE..HEAD` 출력 전체가 Step 3 producer 프롬프트의 `{DIFF}`가 된다. producer는 git을 돌리지 않는다 — 셸이 없는 에이전트로 띄우기 때문이다(Step 3, C-6). 삭제된 파일의 옛 내용도 이 diff의 `-` 줄에 들어 있다. 제외 경로는 `{CHANGED_FILES}`와 지적 범위에서만 빼고, `{DIFF}`에는 테스트 파일 변경까지 그대로 담는다 — 테스트는 지적 대상에서 빠질 뿐 증거에서 빠지지 않는다(C-5).

### Step 2: Lint 확인 (read-only)

`00-rule.md` 00-9 실행 안전 계약을 따른다. **자동 수정은 실행하지 않는다.**

- `package.json`/lint config에서 lint 명령 확인
- 수정 옵션 없이 실행 (`--fix`, `--write` 금지)
- 자동 수정 가능한 항목은 실행하지 말고 개수만 기록
- 사용자가 명시적으로 요청한 경우에만 자동 수정

### Step 3: 단일 Sub-Agent Dispatch

**단 하나의 sub-agent**만 dispatch한다. `run_in_background=false`로 즉시 실행.

**producer는 `subagent_type="react-code-review-plugin:rule-module-reviewer"`로 띄운다(C-6).** 이 에이전트는 `Read`·`Grep`·`Glob`만 가진다 — 쓰기 도구도 셸도 없어서 실제로 고칠 수 없다. lint는 Step 2에서 오케스트레이터가 이미 돌렸으므로 producer에게 셸이 필요 없다. `general` 같은 만능 에이전트나 셸을 가진 `correctness-reviewer`로 띄우지 않는다. 런타임이 sub-agent의 도구를 제한하지 못하면(이 에이전트를 설치하지 않는 호스트 포함) C-6의 대체 경로 — 격리된 사본에서 실행하거나 producer 없이 오케스트레이터가 직접 리뷰 — 를 따르고, 그 사실을 리포트에 적는다.

```
task(
  subagent_type="react-code-review-plugin:rule-module-reviewer",
  load_skills=[],
  description="Fast Code Review (single pass)",
  prompt="아래 지시에 따라 빠른 코드 리뷰를 수행하세요.

## 리뷰 대상
- 기준: {MERGE_BASE}
- 대상: HEAD
- 변경 파일: {CHANGED_FILES}
- 제외 파일(지적하지 않을 경로): `__test__/**`, `__tests__/**`, `*.test.*`, `*.spec.*`, `__mocks__/**`, `mock/**`, `mocks/**`, `*.mock.*`, 테스트/목 전용 fixture/mock data

## Diff
{DIFF — Step 1에서 오케스트레이터가 수집한 git diff {MERGE_BASE}..HEAD 본문 전체. 테스트 파일 변경 포함}

## 리뷰 수행 방법
1. 위 `## Diff`가 리뷰 대상의 전부입니다. git을 직접 실행하지 마세요 — diff는 오케스트레이터가 이미 수집했고, 삭제된 파일의 옛 내용도 그 diff의 `-` 줄에 있습니다
2. diff만으로 판단이 서지 않을 때만 그 diff가 가리키는 파일을 Read로 더 읽으세요. 변경 파일 전체를 습관적으로 다시 읽지 마세요
3. 아래 리뷰 규칙 전체를 적용해 위반 사항 탐지
4. 출력은 파일별 가장 중요한 이슈 1개만
5. 파일 전체를 읽더라도 **지적은 diff에 포함된 변경 라인** 또는 그 변경 때문에 직접 깨진 **인접 라인/구조**로 제한. diff가 삭제하거나 바꾼 export·함수·타입·상수·prop을 diff 밖 코드가 아직 참조하면, 그 참조는 이 변경 때문에 깨진 구조다(`fast.md` 20. 삭제 회귀 — 아래 출력 원칙의 예외)

## 리뷰 규칙
아래 파일을 먼저 Read 한 뒤 그 규칙을 기반으로 리뷰하세요:
- `{RULES_DIR}/fast.md`

이 문서 하나만 사용합니다. 같은 폴더의 숫자 prefix 상세 모듈은 참조하지 마세요.
규칙 ID는 `fast.md`가 지시하는 대로 파일 prefix와 일치하는 형식(`03-1`, `16-2`, `10-SSOT`)으로 표기하세요.

## 출력 원칙
- 사용자가 다른 언어를 명시하지 않은 한 모든 리뷰 결과/코멘트/리포트는 한국어로 작성하세요.
- 같은 파일에서 여러 위반이 보이면 가장 심각한 것 1개만 출력
- severity 우선순위: 🔴 > 🟡 > 🔵
- 단순 스타일, 반복 지적, 영향이 작은 코멘트는 생략
- 이슈가 없는 파일은 출력에서 제외
- diff에 포함되지 않은 기존 코드는 지적 금지
  - 예외: diff가 삭제·변경한 export·함수·타입·상수·prop을 diff 밖 코드가 아직 참조하면, 그 참조 위치를 삭제 회귀 지적의 근거나 위치로 인용할 수 있다. 원인은 diff 안의 변경이다. 확인은 삭제·변경된 심볼 이름을 Grep으로 찾는 targeted reference check로 한정하고, 무엇을 어디까지 찾았는지 적는다
- 제외 파일은 지적하지 않는다 — 영향 범위를 읽는 증거로만 쓴다
- 파일 전체를 읽었다는 이유로 리뷰 범위를 파일 전체로 넓히지 말 것
- 추측 금지 — 실제 코드를 읽고 확인
- 가능하면 각 이슈는 **문제 → 현재 선택 → 왜 부족한지**가 드러나게 쓴다

## 출력 형식 (마크다운)

# 빠른 코드 리뷰 리포트

> **기준**: {MERGE_BASE} | **대상**: HEAD
> **변경 파일**: {N}개

## 한눈에 보기
- 🔴: N개 / 🟡: N개 / 🔵: N개
- 머지 전 반드시 볼 파일: {N}개

## 파일별 핵심 이슈

| 심각도 | 파일 | 핵심 이슈 | 이유 | 개선 방향 |
|----------|------|----------|------|------------|
| 🔴 | path/to/file | ... | ... | ... |

## 통과
- (이슈 없는 파일 리스트, 또는 '전부 통과' 요약)

**머지 가능 여부**: 🔴 {N}개 → {가능/불가/수정 후 가능}"
)
```

### Step 4: 결과 전달

sub-agent의 출력을 그대로 사용자에게 전달한다. 추가 편집/재정렬은 하지 않는다 (fast 취지). 다만 명백한 형식 오류가 있으면 짧게 보정한다. producer의 도구를 제한하지 못해 C-6 대체 경로로 돌았으면 그 사실 한 줄만 리포트 상단에 덧붙인다 — 그것은 지적의 편집이 아니라 이 실행이 어떤 조건에서 돌았는지에 대한 사실이다.

### Step 5: 문서 저장

리포트 저장은 `workflow-contract.md` C-7을 따른다 (`workflow-name`은 `fast`). 섹션 이름·순서·헤딩 레벨도 C-7 **문서 골격**을 따르되, fast에는 모듈 섹션·특수 패스·요약이 없으므로 그 섹션들은 생략한다. 문서 내용은 **이번 브랜치에서 바뀐 파일별 핵심 이슈** 중심으로 유지하고, 일반 설명은 최소화한다.

## 사용법

```
/code-review-fast                    — 현재 브랜치 전체 빠른 리뷰
/code-review-fast main..feature/x    — 특정 범위 빠른 리뷰
```

모듈 단위 축소(`--module ...`)는 이 모드에서 더 이상 지원하지 않는다. 단일 에이전트 + 단일 압축 문서 구조이므로 모듈 선택은 무의미하다. 특정 주제만 보고 싶다면 사용자가 프롬프트로 지시한다 (예: "타입 안전성만 집중해서 봐줘").

## 주의사항

- 이 모드는 완전한 리뷰 대신 **우선순위 높은 지적만 빠르게 보는 저지연/timeout-safe 경로**다
- 큐 포화(queue saturation), tail latency, timeout 위험이 우려될 때 이 모드를 사용한다
- 상세/포괄적 리뷰가 필요하면 `/code-review-full`을 사용한다
- fast 룰 문서(`fast.md`)는 숫자 prefix 상세 모듈 전체의 압축본이며, 모듈이 추가·삭제·재배치되면 fast.md의 해당 섹션도 함께 갱신해야 한다. 압축하면서 원본의 예외 조항을 빠뜨리면 오탐이 생긴다
- 빈 diff면 리뷰를 수행하지 않는다
- lint는 수정 옵션 없이 실행하고, 자동 수정은 사용자가 요청했을 때만 한다 (`00-rule.md` 00-9)
- diff 수집과 lint는 오케스트레이터가 하고, producer는 받은 diff를 읽기만 하는 `rule-module-reviewer`로 띄운다 (C-6)
