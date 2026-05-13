---
name: code-review-full
description: Use when the user invokes /code-review-full or asks for a full code review orchestrator that combines general, props, math, and exception review coverage while preserving existing review modes.
---

# 전체 코드 리뷰 오케스트레이터

## 개요
일반, Props, 수학, 예외 리뷰 모드를 아우르는 전체 리뷰 오케스트레이션이다. 이 skill은 `code-review`, `code-review-props`, `code-review-math`, `code-review-exception`을 대체하지 않으며, 각 모드는 계속 독립적으로 사용할 수 있다.

## 추가 보존
- `code-review`는 기본 일반 리뷰 skill로 유지한다.
- `code-review-props`는 독립 Props/인자 전달 리뷰 skill로 유지한다.
- `code-review-math`는 독립 선형대수 리뷰 skill로 유지한다.
- `code-review-exception`는 독립 예외/에러 처리 리뷰 skill로 유지한다.
- 이 skill은 더 넓은 오케스트레이션만 추가한다.

## 오케스트레이션
1. 변경 집합만 기준으로 리뷰 범위를 결정한다.
    - `dev` 브랜치가 있으면 그 merge-base를 우선 사용한다.
    - 그 기준 이후 변경된 파일만 리뷰한다.
    - lint/autofix는 기존 리뷰 skill들과 같은 방향으로 맞춘다: 판단 전에 자동 수정 가능한 노이즈는 정리하되, 그 때문에 범위를 넓히지는 않는다.
2. 패스 순서는 일반 → Props → 수학 → 예외 → 요약/리포팅이다.
3. 일반 패스 규칙.
    - `C:/Users/bhmun/.claude/review-rules/[0-9]*.md`의 숫자 prefix 모듈만 사용한다.
    - `props.md`, `math.md`, `exception.md`, `fast.md`는 명시적으로 제외한다.
    - 변경된 파일만 평가하고 diff 밖 저장소 전체는 스캔하지 않는다.
    - 일반 코드 리뷰 패스에서 테스트/목 전용 경로를 제외한다: `__test__/**`, `__tests__/**`, `*.test.*`, `*.spec.*`, `__mocks__/**`, `mock/**`, `mocks/**`, `*.mock.*`, 전용 fixture/mock-data 자산.
 4. Props 패스 규칙.
    - props drilling, 과도한 props, handler tunneling, argument-passing 구조와 관련된 변경 파일만 본다.
    - `C:/Users/bhmun/.claude/review-rules/props.md`만 읽는다.
    - 관련 범위가 없으면 `SKIPPED`로 기록한다.
    - 범위를 만들기 위해 repo-wide 스캔으로 되돌아가지 않는다.
 5. 수학 패스 규칙.
     - 행렬 또는 선형대수 작업이 있는 변경 파일만 본다.
     - `C:/Users/bhmun/.claude/review-rules/math.md`만 읽는다.
     - 관련 범위가 없으면 `SKIPPED`로 기록한다.
     - 범위를 만들기 위해 repo-wide 스캔으로 되돌아가지 않는다.
 6. 예외 패스 규칙.
    - 예외 처리, 에러 전파, fallback, 복구, validation flow와 관련된 변경 파일만 본다.
    - `C:/Users/bhmun/.claude/review-rules/exception.md`만 읽는다.
    - 관련 범위가 없으면 `SKIPPED`로 기록한다.
    - 범위를 만들기 위해 repo-wide 스캔으로 되돌아가지 않는다.
 7. 요약/리포팅 규칙.
    - 네 패스가 모두 끝난 뒤에 패스 리포트를 출력한다.
    - 패스별 출처 라벨이 일반, Props, 수학, 예외로 구분되도록 유지한다.
    - 특수 범위 결정이 끝난 뒤에만 패스 출력물을 병합한다.

## 리포팅
- 네 패스의 리포트를 각각 개별로 출력하고, 각 패스 출력은 생성된 그대로 유지한다: 일반, Props, 수학, 예외.
- 개별 패스 리포트를 출력 전에 다시 쓰거나 압축하거나 합치지 않는다.
- 패스에 적용 범위가 없으면 패스 이름, 사유, 그리고 `SKIPPED`가 비차단임을 명시해 `SKIPPED`로 출력한다.
- 모든 패스가 끝난 뒤에는 사용자가 다른 언어를 명시하지 않은 한 한국어로 전체 요약 리포트를 출력한다.
- 요약은 기존 review-doc 관례를 따라 실용적인 파일명 예시 `code-review-full-{branch-name}-{date}.md`로 저장한다.
- sibling review skill들과 같은 문서 저장 관례를 유지하고, 프로젝트가 이미 관례를 따르고 있으면 절대 경로를 강제하지 않는다.

### 요약 내용
- 일반, Props, 수학, 예외 패스 상태 표를 포함한다.
- SKIPPED 사유를 요약 안에 함께 넣는다.
- 심각도는 🔴 오류, 🟡 경고, 🔵 정보 순으로 묶는다.
- 중복 제거된 지적, 출처 패스 라벨, `미해결 / 후속 확인 필요` 섹션을 포함한다.
- 특수 패스의 세부사항을 요약 안에 유지하고, 일반/Props/수학/예외 관찰을 하나의 일반 노트로 뭉개지 않는다.

### 중복 제거 규칙
- 다음이 모두 같을 때만 지적을 병합한다: 같은 파일, 같은/가까운 라인, 같은 근본 원인.
- 병합된 지적에는 모든 출처 패스 라벨을 유지한다.
- 지적을 병합할 때는 가장 높은 심각도를 유지한다.
- 관련된 일반 지적이 이미 있다는 이유로 특수 세부사항을 버리지 않는다.
- 근본 원인, 범위, 특수 의미가 다르면 같은 파일을 건드려도 분리해서 둔다.

### 출처 라벨링
- 모든 지적은 출처 패스 라벨 `일반`, `Props`, `수학`, `예외` 중 하나를 유지해야 한다.
- 중복 제거된 지적이 여러 출처를 합치면 기여한 라벨을 모두 적는다.
- `SKIPPED` 항목도 패스 라벨을 유지해 어떤 패스가 실행되지 않았는지 요약에서 보이게 한다.

## 참고
- 이 스킬은 기존 리뷰 스킬에 덧붙이는 오케스트레이션 레이어다.
- 기존 리뷰 스킬의 의미를 바꾸지 않는다.
