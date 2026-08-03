---
name: code-review-math
description: Use when the user invokes /code-review-math or wants a specialized review of linear algebra matrix code — dimension checks, transpose/inverse rules, eigenvalue relations, storage-order pitfalls. Excluded from the default /code-review.
---

# Math (Linear Algebra) Code Review

선형대수학의 **행렬 계산** 전용 리뷰 모드. 일반 코드 품질·아키텍처 검사와는 분리된 특수 리뷰이며, 일반 `/code-review`에서는 자동 제외된다.

## 공통 계약

`RULES_DIR` 해석, 범위 결정, 제외 경로, 실행 안전, 리포트 저장, 실패 보고는 **`$RULES_DIR/workflow-contract.md`** 를 따른다. 아래는 이 워크플로우의 차이다.

| 항목 | 이 워크플로우 |
|------|---------------|
| `workflow-name` | `math` |
| 모듈 집합 | `$RULES_DIR/math.md` 단일 문서 (숫자 prefix 모듈·다른 특수 문서 미로드) |
| 규칙 ID | `A-{n}` / `C-{n}` |
| 적용 조건 | 행렬·선형대수 코드가 변경에 포함될 때. 없으면 `SKIPPED` (C-3, C-8) |

일반 아키텍처/타입/상태 리뷰가 필요하면 `/code-review` 또는 `/code-review-fast`를 별도로 실행한다.

## 검사 범위

- **A. 코드 구현**: 차원 mismatch, `@` vs `*` 혼동, `inv()` 대신 `solve()`, broadcasting, storage order(row/column-major), float 동등 비교, 벡터화 등
- **C. 순수 수학 논리**: 역행렬 존재 조건, transpose/inverse 순서 반전, eigenvalue 관계, projection 공식, determinant/trace/rank 규칙, orthogonal/SPD 가정, 분해 전제 조건 등

**B(docstring-코드 일치)는 범위에서 제외**한다.

## 대상 스택

언어/라이브러리 무관 범용이지만, 특히 다음 스택의 함정을 유의:

- numpy, scipy, PyTorch, JAX (row-major, `@` = matmul, `*` = elementwise)
- Three.js Matrix3/Matrix4 (**column-major**, `.elements` 순서)
- WebGL / GLSL (**column-major**, `A * B` = matmul)
- Eigen C++ (column-major 기본)
- ml-matrix, mathjs, tensorflow.js

라이브러리 경계를 넘나드는 코드(예: numpy → WebGL uniform)에서 transpose 누락/중복이 빈번하므로 집중 검토.

## 실행 절차

### Step 1: Diff 범위 결정

범위 결정은 `workflow-contract.md` C-4를 따른다. 결정된 범위로 `git diff --stat $MERGE_BASE..HEAD`와 `git diff $MERGE_BASE..HEAD`를 확인한다. 제외 경로는 C-5를 따른다. 변경 파일 중 **행렬/3D 변환 연산이 포함된 파일만** 리뷰 대상으로 좁힌다 (해당 연산이 전혀 없는 UI 전용 파일은 제외).

### Step 2: Lint 확인 (read-only, 선택)

`00-rule.md` 00-9 실행 안전 계약을 따른다. lint가 설정돼 있으면 **수정 옵션 없이** 실행하고, 자동 수정은 사용자가 명시적으로 요청했을 때만 한다. 수학 전용 리뷰는 lint와 별도 축이므로 lint가 없어도 그대로 진행 가능하다.

### Step 3: 단일 Sub-Agent Dispatch

**단 하나의 sub-agent**만 dispatch한다. `run_in_background=false`로 즉시 실행.

```
task(
  category="unspecified-high",
  load_skills=[],
  description="Math Code Review (linear algebra)",
  prompt="아래 지시에 따라 선형대수 행렬 코드 리뷰를 수행하세요.

## 리뷰 대상
- 기준: {MERGE_BASE}
- 대상: HEAD
- 변경 파일 (행렬 연산 포함된 것만): {CHANGED_MATH_FILES}

## 리뷰 수행 방법
1. `git diff {MERGE_BASE}..HEAD` 로 전체 diff 확인
2. 변경 파일을 직접 읽어서 행렬 shape/차원을 추적
3. 아래 리뷰 규칙 전체를 적용해 위반 사항 탐지
4. 차원 추적은 주석에 의존하지 말고 코드에서 직접 확인

## 리뷰 규칙
아래 파일을 먼저 Read 한 뒤 그 규칙을 기반으로 리뷰하세요:
- `{RULES_DIR}/math.md`

이 문서 하나만 사용합니다. 같은 폴더의 숫자 prefix 모듈과 `fast.md`, `props.md`, `exception.md`는 참조하지 마세요.

## 출력 원칙
- 사용자가 다른 언어를 명시하지 않은 한 모든 리뷰 결과/코멘트/리포트는 한국어로 작성하세요.
- severity 우선순위: 🔴 > 🟡 > 🔵
- 위치(파일:line)와 규칙 번호(A-x / C-x)를 반드시 표기
- Shape/차원을 추적해서 명시 (예: `A: (3,4), B: (4,5), A @ B: (3,5) ✓`)
- diff에 없는 기존 수학 코드는 지적 금지
- 추측 금지 — 의심스러우면 '검증 필요'로 표기
- 이슈 없으면 '위반 없음'만 출력

## 출력 형식 (마크다운)

# 수학 코드 리뷰 리포트

> **기준**: {MERGE_BASE} | **대상**: HEAD
> **검사 파일**: {N}개 (행렬 연산 포함)

## 한눈에 보기
- 🔴: N개 / 🟡: N개 / 🔵: N개

## 위반 목록

| 심각도 | 파일 | 위치 | 분류 | 이슈 | 개선 방향 |
|----------|------|------|------|------|----------|
| 🔴 | path/to/file | L123 | A-1 | ... | ... |
| 🟡 | path/to/file | L45 | C-4 | ... | ... |

## 통과
- (이슈 없는 파일 리스트, 또는 '전부 통과' 요약)

**머지 가능 여부**: 🔴 {N}개 → {가능/불가/수정 후 가능}"
)
```

### Step 4: 결과 전달

sub-agent의 출력을 그대로 사용자에게 전달한다. 명백한 형식 오류만 짧게 보정.

### Step 5: 문서 저장

리포트 저장은 `workflow-contract.md` C-7을 따른다 (`workflow-name`은 `math`). 문서 내용은 **이번 브랜치 diff 안에서 행렬 연산이 바뀐 파일과 그 수학적 이슈** 중심으로 쓴다.

## 사용법

```
/code-review-math                    — 현재 브랜치의 행렬 연산 코드 리뷰
/code-review-math main..feature/x    — 특정 범위 리뷰
```

## 주의사항

- 이 모드는 일반 코드 품질·아키텍처를 검사하지 않는다. 그쪽은 `/code-review` 또는 `/code-review-fast`로 별도 실행
- 변경 파일에 행렬 연산이 없으면 "대상 없음"으로 즉시 종료
- `math.md`는 숫자 prefix가 없어 `/code-review`의 자동 모듈 스캔에서 제외됨 (컨벤션으로 분리)
- 향후 다른 수학 분야(미적분, 확률/통계 등) 전용 리뷰를 추가할 때도 같은 패턴(`calc.md`, `stat.md`)으로 두고 전용 skill을 만든다
