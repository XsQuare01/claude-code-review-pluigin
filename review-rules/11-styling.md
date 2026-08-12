# 스타일링 시스템 검증

이 모듈은 **Tailwind + 시맨틱 디자인 토큰 시스템**을 전제한다. CSS Modules, CSS-in-JS, vanilla-extract 등 다른 스타일링 체계를 쓰는 프로젝트에는 적용하지 않는다.

색상 대비, motion 민감성 등 **접근성 영향**은 `12-accessibility.md`가 우선한다.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 디자인 시스템 위반, 재사용성/일관성 크게 저해 |
| 🟡 WARNING | 스타일링 방식 선택 부적절, 유지보수성 저하 |
| 🔵 INFO | className 정리, 추출, 단순화 제안 |

---

## 11-1. Tailwind 우선 원칙 🔴

정적 레이아웃, 상태 표현, hover/focus, 유한한 조건 분기는 기본적으로 Tailwind `className`을 사용해야 합니다. 정적 값에 `style={{}}`를 사용한 경우를 찾으세요.

## 11-2. Inline style 허용 범위 🟡

`style={{}}`는 JS 런타임 계산값(동적 위치, 크기, transform)일 때만 허용. `isActive ? A : B` 같은 유한 조건은 Tailwind 조건부 className으로 바꿔야 합니다.

## 11-3. CSS 파일 사용 기준 🟡

CSS 파일은 Tailwind로 표현하기 어려운 경우에만 허용:

- keyframe 애니메이션
- 복잡한 선택자, `:not`, 구조 의존 스타일
- gradient, clip-path, mask
- 써드파티 컴포넌트 오버라이드

단순 레이아웃/spacing/border/flex/grid 때문에 새 `.css` 파일을 만든 경우를 지적하세요.

## 11-4. 디자인 토큰 사용 🔴

색상, 배경, border, shadow는 프로젝트 시맨틱 토큰을 우선 사용해야 합니다. 다음 위반을 찾으세요:

- 토큰에 있는 값을 hex로 하드코딩
- Tailwind 기본 팔레트 사용 (`gray-800`, `text-blue-500` 등)
- 반복되는 arbitrary color/value를 토큰 후보로 남기지 않음

## 11-5. 금지 패턴 🟡

- `!important`
- `@apply` 남용
- 컴포넌트 전용 CSS를 전역 스타일에 추가

## 11-6. className 관리 🔵

- className이 과도하게 길면 배열 + `.join(' ')` 또는 프로젝트의 병합 유틸로 정리
- 동일한 스타일 묶음이 반복되면 컴포넌트/상수로 추출
- 복잡한 스타일 조건식이 렌더링 가독성을 해치면 분리 제안
- 조건부 className을 문자열 연결로 만들어 Tailwind가 클래스를 정적으로 추출하지 못하는 경우

## 11-7. 파일 위치 규칙 🔵

- 전역 스타일은 `app/styles/`
- 컴포넌트 전용 CSS는 해당 컴포넌트와 같은 폴더
- 스타일 책임이 FSD 레이어와 맞지 않으면 `01-fsd.md`와 함께 지적

## 11-OUTPUT. 출력 형식

<!-- REVIEW_RESULT_CONTRACT_V1_PRODUCER_OUTPUT -->

이 문서를 producer prompt에 쓸 때는 **`REVIEW_RESULT_CONTRACT_V1`** 을 따른다. 응답은 Markdown 표나 헤딩이 아니라 **raw JSON 객체 하나만** 반환한다.

- top-level에는 `schemaVersion`, `findings`, `openQuestions`를 항상 포함하고 `schemaVersion`은 `1`이어야 한다.
- `severity`는 producer가 내지 않는다. 이 모듈은 `impact`와 `confidence`만 판정한다.
- Tailwind 적용 조건, inline style 허용 범위, 디자인 토큰, className 관리 같은 도메인별 설명은 새 schema field를 만들지 말고 `body`, `recommendation`, `evidence`에 담는다.
- `00-rule.md` 00-11에 걸리는 unresolved absence/possibility claim, search scope 미완료, 추가 탐색 요청만 `openQuestions`로 보낸다.
- 결함은 성립하지만 exact location만 확인하지 못했으면 finding을 유지하고 `location.kind="unverified"`와 `reason`만 사용한다.
- producer 문자열 필드는 최종 리포트의 신뢰된 Markdown이 아니다. heading/table/raw HTML/link를 직접 만들려고 하지 말고 plain prose만 넣는다.
