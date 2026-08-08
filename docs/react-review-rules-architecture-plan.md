# Draft: React Review Rules Architecture

> **기록 문서.** 개편 착수 시점의 계획 초안이다. 실제 실행 결과와 그에 대한 검토는 `react-review-rules-delta-review.md`, 현재 상태는 `README.md`를 본다.

## Requirements (confirmed)
- 현재 코드 리뷰 체계는 React 전용 리뷰 문서다.
- 아키텍처, React, TypeScript 관점에서 문제가 있는 부분을 찾아 변경 계획을 작성한다.

## Technical Decisions
- 실제 리뷰 진입점과 규칙 문서 전체를 근거로 문제를 분류한다.
- 최신 React 및 TypeScript 공식 문서와 대조해 기술적으로 오래되거나 과도한 규칙을 구분한다.
- 구현은 수행하지 않고 단일 실행 계획으로 정리한다.
- 기본 권고안은 기존 명령 7종을 유지하면서 규칙을 Core / React / TypeScript / 선택형 프로젝트 Profile / Specialist로 재구성하는 것이다.
- 규칙 본문은 Markdown을 정본으로 유지하고, 생성기 대신 경량 catalog와 검증 스크립트로 인벤토리·ID·적용 범위·버전 조건을 관리한다.
- 리뷰 명령은 원칙적으로 read-only로 바꾸고 자동 lint 수정은 분리한다.

## Research Findings
- `README.md`, 여러 `skills/*/SKILL.md`, 실제 numbered rule 목록이 서로 다르며 `13-dangerous-change.md`는 참조되지만 존재하지 않는다.
- `fast.md`는 원본 규칙을 수동 압축한 중복 산출물이라 조건·심각도·예외가 이미 드리프트했다.
- 공통 계약이 여러 스킬에 반복되고 `~/.claude/review-rules/` 경로, diff 범위, read-only, autofix, 보고서 이름, 테스트 제외 정책이 일관되지 않다.
- React 규칙에는 RSC server/client 경계, render purity, Suspense/transition, hydration, external store, React 19 및 Compiler 조건부 지침이 빠져 있다.
- StrictMode가 클릭을 중복 실행한다는 설명, 모든 fetch의 abort 강제, 객체 dependency 금지, 무조건적 memoization 등 오탐을 만드는 지침이 있다.
- TypeScript 규칙은 모든 `any`/`@ts-expect-error`/inline props type/제약 없는 generic을 오류로 보는 잘못된 절대 규칙을 포함하고 strict 설정·narrowing·trust boundary·variance·module semantics가 부족하다.
- FSD, Electron, Tailwind, TanStack Query, Three.js 정책이 일반 React correctness와 섞여 있어 선택형 profile 분리가 필요하다.
- 자동 문서 검증, workflow contract test, lint/typecheck, 링크 검사, packaging 검사, CI가 모두 없다.
- 공식 기준은 현재 React 19.2 및 TypeScript 6.0이며 RSC, Compiler, React 19 API와 일부 TS 설정은 버전/프레임워크 조건부로 적용해야 한다.
- Oracle은 최소 수정이나 완전 생성 파이프라인보다 모듈 재구성 + 경량 catalog/validation의 중간안을 권고했다.

## Open Questions
- 규칙 문서 최소 수정인지, 실행 스킬·공통 계약·catalog·검증/CI까지 포함한 구조 개편인지 확정 필요.
- 지원 기준을 React 19.2/TypeScript 6.0 전용으로 둘지, React 18+/TypeScript 5+ 호환 매트릭스를 유지할지 확정 필요.
- 자동 검증과 CI를 이번 범위에 포함할지 확정 필요.
- 이전 rule ID/파일 경로의 외부 소비 여부와 호환 정책을 확정해야 한다.
- 프로젝트 profile 활성화는 명시적 설정/옵션을 기본으로 하되 자동 감지를 허용할지 확정해야 한다.

## Scope Boundaries
- INCLUDE: 아키텍처 적합성, React 규칙 정확성, TypeScript 타입 안전성, 규칙 간 충돌·중복·누락, 기존 workflow 호환성.
- EXCLUDE: 실제 소스/문서 수정 및 계획 실행.
- 잠정 EXCLUDE: Markdown 본문 생성 DSL, 공식 문서 자동 수집기, 일반 백엔드·보안 리뷰로의 범위 확장.
