# 스타일링 시스템 검증

이 프로젝트는 Tailwind 우선 스타일링 원칙과 디자인 토큰 기반 UI 시스템을 따릅니다.

이 모듈은 **Tailwind + 시맨틱 디자인 토큰 시스템**을 전제로 한다. CSS Modules, CSS-in-JS, vanilla-extract 등 다른 스타일링 체계를 쓰는 프로젝트에는 그대로 일반화하지 않는다.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 디자인 시스템 위반, 재사용성/일관성 크게 저해 |
| 🟡 WARNING | 스타일링 방식 선택 부적절, 유지보수성 저하 |
| 🔵 INFO | className 정리, 추출, 단순화 제안 |

---

## 8-1. Tailwind 우선 원칙 🔴

정적 레이아웃, 상태 표현, hover/focus, 유한한 조건 분기는 기본적으로 Tailwind `className`을 사용해야 합니다. 정적 값에 `style={{}}`를 사용한 경우를 찾으세요.

## 8-2. Inline style 허용 범위 🟡

`style={{}}`는 JS 런타임 계산값(동적 위치, 크기, transform)일 때만 허용. `isActive ? A : B` 같은 유한 조건은 Tailwind 조건부 className으로 바꿔야 합니다.

## 8-3. CSS 파일 사용 기준 🟡

CSS 파일은 Tailwind로 표현하기 어려운 경우에만 허용:
- keyframe 애니메이션
- 복잡한 선택자, `:not`, 구조 의존 스타일
- gradient, clip-path, mask
- 써드파티 컴포넌트 오버라이드

단순 레이아웃/spacing/border/flex/grid 때문에 새 `.css` 파일을 만든 경우를 지적하세요.

## 8-4. 디자인 토큰 사용 🔴

색상, 배경, border, shadow는 프로젝트 시맨틱 토큰을 우선 사용해야 합니다. 다음 위반을 찾으세요:

- 토큰에 있는 값을 hex로 하드코딩
- Tailwind 기본 팔레트 사용 (`gray-800`, `text-blue-500` 등)
- 반복되는 arbitrary color/value를 토큰 후보로 남기지 않음

## 8-5. 금지 패턴 🟡

- `!important`
- `@apply` 남용
- 컴포넌트 전용 CSS를 전역 스타일에 추가
- renderer 스타일 코드에서 디자인 시스템과 무관한 값 남용

## 8-6. className 관리 🔵

- className이 과도하게 길면 배열 + `.join(' ')` 또는 적절한 유틸로 정리
- 동일한 스타일 묶음이 반복되면 컴포넌트/상수로 추출
- 복잡한 스타일 조건식이 렌더링 가독성을 해치면 분리 제안

## 8-7. 파일 위치 규칙 🔵

- 전역 스타일은 `app/styles/`
- 컴포넌트 전용 CSS는 해당 컴포넌트와 같은 폴더
- 스타일 책임이 FSD 레이어와 맞지 않으면 함께 지적
