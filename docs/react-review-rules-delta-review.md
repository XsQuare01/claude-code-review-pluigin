# React 전용 코드 리뷰 규칙 개편 비교 리뷰

> **기록 문서 — 열린 TODO 목록이 아니다.** 여기서 제기한 P0 8건과 P1 대부분은 이후 릴리스에서 반영됐다. `--module` 필터 구현, `04-state.md`의 `17-4` 참조 수정, `21-rsc.md`, `catalog.json`, `workflow-contract.md`, validator와 CI, `tests/workflow-fixtures.md`가 그 결과물이다. 현재 규칙 체계의 상태는 `README.md`가 정본이며, 이 문서는 그 변경들이 왜 필요했는지를 남기기 위해 보존한다.
>
> 검토 기준: `3d52750 refactor: restructure review rules as React-only system`
>
> 검토 범위: 아키텍처·워크플로우, React, TypeScript, 규칙 정합성·자동화
>
> 결론: 기존 구조 결함은 의미 있게 개선됐지만, 현재 상태를 "React/TypeScript 관점의 완료된 개편"으로 보기에는 주요 오탐 규칙과 실행 계약 결함이 남아 있다.

## 1. 요약

이번 변경은 기존 numbered rule 인벤토리를 `00`~`20`으로 정리하고, React 런타임 규칙·React 성능·동시성·위험 변경을 별도 모듈로 분리했다. 규칙 경로 탐색, 보고서 이름, rule ID 형식도 이전보다 명확해졌다.

반면 다음 문제는 머지 전 수정이 권장된다.

1. `02-type.md`에 잘못된 TypeScript 절대 규칙이 그대로 남아 있다.
2. React 규칙에 `use`, render-phase state 조정, fetch cancellation, dependency identity, memoization 관련 오탐이 있다.
3. `17-concurrency.md`와 `fast.md`가 StrictMode를 사용자 이벤트 중복 원인처럼 기술한다.
4. read-only 요청에서도 일부 workflow가 autofix 또는 보고서 파일 생성을 수행할 수 있다.
5. `/code-review --module`은 문서화됐지만 실제 필터링 절차가 없다.
6. full workflow에서 `00-rule.md`가 공통 규칙과 독립 모듈로 중복 실행될 수 있다.
7. `fast.md`가 원본 규칙의 severity와 applicability 조건을 이미 잃었다.
8. cross-reference, ID, fast 동기화를 검증하는 자동화와 CI가 없다.

따라서 현재 변경은 **부분 승인** 수준이며, 아래 P0 항목을 수정한 뒤 재검토하는 것이 적절하다.

## 2. 기존 조사 대비 변경 결과

| 기존 문제 | 상태 | 현재 평가 |
|---|---|---|
| 문서와 실제 모듈 인벤토리 불일치 | 해결 | README와 실제 파일이 `00`~`20`으로 정렬됨 (`README.md:21-45`) |
| 존재하지 않는 dangerous-change 참조 | 해결 | `18-dangerous-change.md`가 추가되고 관련 참조가 유효해짐 |
| hard-coded `~/.claude/review-rules` | 해결 | plugin root → project → home fallback으로 통일 (`README.md:70-78`, `skills/code-review/SKILL.md:12-24`) |
| rule ID가 파일 번호와 불일치 | 해결 | 공통 ID 계약과 특수 ID 형식이 정리됨 (`review-rules/00-rule.md:27-39`) |
| 보고서 파일명 불일치 | 대체로 해결 | workflow-name 포함 형식이 공통화됨 (`review-rules/00-rule.md:54-61`) |
| orphan correctness reviewer | 부분 해결 | 선택적 reviewer로 문서화됐지만 자체 범위 계약은 별도 정리가 필요함 (`README.md:80-82`) |
| React render purity 누락 | 해결 | 렌더 부수효과·비결정성·동시 렌더 전제를 추가함 (`review-rules/03-react-rules.md:49-73,133-140`) |
| Effect 목적과 derived state 누락 | 해결 | 외부 시스템 동기화와 렌더 파생을 구분함 (`review-rules/03-react-rules.md:95-124`) |
| StrictMode가 클릭을 중복 실행한다는 설명 | 미해결 | `17-concurrency.md:24-28`, `fast.md:138-142`에 여전히 남아 있음 |
| 모든 fetch에 AbortController 강제 | 미해결 | `review-rules/04-state.md:22-42`가 stale-result ignore 대안을 인정하지 않음 |
| 객체/배열 dependency 자체를 오류로 판단 | 미해결 | `review-rules/04-state.md:45-55`가 identity churn 여부 없이 직접 삽입을 지적함 |
| 무조건적인 memoization | 부분 해결 | 성능 모듈은 측정을 요구하지만 Context 규칙은 여전히 `useMemo`를 강제함 (`04-state.md:93-106`, `14-react-performance.md:73-79,109-112`) |
| TypeScript 절대 규칙 | 미해결 | `any`, `@ts-expect-error`, inline Props, event type, unconstrained generic 규칙이 그대로 남아 있음 (`02-type.md:13-19,33-44,97-110`) |
| RSC·hydration·transition·external store 누락 | 부분 해결 | hydration/transition/external store는 기초만 추가됐고 RSC와 React 19 API는 없음 |
| FSD/Electron/Tailwind 등 프로젝트 전용 규칙 혼합 | 부분 해결 | 모듈 header 조건은 추가됐지만 catalog/profile 기반 활성화는 없음 |
| `fast.md` 수동 드리프트 | 미해결 | 유지보수 경고만 추가됐고 실제 severity·예외 누락이 존재함 (`README.md:109-113`, `fast.md:1-5`) |
| 자동 검증·workflow test·CI 부재 | 미해결 | validator, fixture, test harness, CI가 추가되지 않음 |

## 3. P0 — 머지 전 필수 수정

### P0-1. TypeScript 규칙의 잘못된 절대 판정을 제거해야 한다

`review-rules/02-type.md:13-19`는 `any`, `@ts-ignore`, `@ts-expect-error`를 모두 동일한 ERROR로 취급한다. `@ts-expect-error`는 오류가 사라지면 실패하는 검증 가능한 suppression이며, 타입 음성 테스트나 추적 가능한 외부 타입 결함에 사용할 수 있다. `any`도 외부 미타입 경계를 격리하는 adapter처럼 제한적으로 정당할 수 있다.

또한 다음 규칙도 의미론적 오류 또는 과도한 제약이다.

- inline Props 금지와 이벤트 타입 강제: `02-type.md:33-42`
- 3필드·3단·5멤버 고정 threshold를 ERROR로 분류: `02-type.md:40-44`
- unconstrained `T`를 `unknown`과 동일하다고 설명: `02-type.md:97-110`

**변경 방향**

- 타입 우회를 전면 금지하지 말고 범위, 소비 위치, 사유, owner, 제거 조건을 검토한다.
- `@ts-expect-error`와 `@ts-ignore`를 분리한다.
- exported/public boundary와 작은 local Props를 구분한다.
- 이벤트 타입은 contextual typing이 끊긴 경우에만 명시를 요구한다.
- generic은 `extends` 유무가 아니라 입력·출력 간 관계 보존과 필요한 capability를 기준으로 본다.

### P0-2. React 규칙의 오탐 가능성을 수정해야 한다

다음 규칙은 유효한 React 코드를 잘못 지적할 수 있다.

| 문제 | 근거 | 변경 방향 |
|---|---|---|
| React 19 `use`의 조건부 호출 예외 누락 | `03-react-rules.md:21-29` | 일반 Hook과 `use(resource)` 예외를 버전 조건부로 분리 |
| 조건부 render-phase state 조정까지 전면 금지 | `03-react-rules.md:49-57` | 다른 컴포넌트 갱신·무한 루프·부수효과와 제한적 guarded adjustment를 구분 |
| 모든 fetch에 AbortController 요구 | `04-state.md:22-42` | abort 또는 stale result ignore 등 실제 race 방지 증거를 인정 |
| 객체/배열/함수 dependency 자체를 오류로 취급 | `04-state.md:45-55` | reactive value 누락과 실제 identity churn을 판정 기준으로 변경 |
| Context value에 `useMemo` 절대 요구 | `04-state.md:93-106` | 소비자 영향, identity contract, profiling, Compiler 설정을 먼저 확인 |
| props→state를 React가 전면 금지한다고 표현 | `03-react-rules.md:95-115` | `initialX`/`defaultX`, intentional draft 등 소유권 계약을 기준으로 판단 |

### P0-3. StrictMode와 사용자 이벤트 중복을 분리해야 한다

`review-rules/17-concurrency.md:24-28`은 mutation action이 double click, rapid re-entry, StrictMode, retry로 중복 실행될 수 있다고 한 문장에 묶는다. StrictMode는 일반적으로 click event 자체를 두 번 dispatch하지 않는다. 렌더·Effect replay에서 mutation이 실행되는 문제와 실제 double-click/retry/re-delivery를 분리해야 한다.

동일 오탐이 `review-rules/fast.md:138-142`에도 복제돼 있다.

### P0-4. read-only와 autofix/파일 저장 계약을 통일해야 한다

공통 규칙은 lint 자동 수정을 먼저 수행하도록 한다 (`review-rules/00-rule.md:72-82`). 기본 workflow만 read-only 예외를 명시한다 (`skills/code-review/SKILL.md:58-67`). full workflow는 여전히 기존 autofix 방향을 따른다 (`skills/code-review-full/SKILL.md:18-23`).

보고서도 공통 규칙상 기본적으로 파일을 생성하며 (`00-rule.md:54-61`), 기본 workflow 외 command는 파일 생성 금지 요청의 우선순위를 명확히 보장하지 않는다.

**변경 방향**

- 리뷰는 기본 read-only로 실행한다.
- lint autofix는 별도 명시적 요청으로 분리한다.
- `read-only`, `no file changes`, `text only`가 모든 workflow의 공통 계약보다 우선함을 명시한다.
- 비수정 lint/test 실행 결과는 review finding과 별도 상태로 보고한다.

### P0-5. `/code-review --module`을 구현하거나 사용법에서 제거해야 한다

`skills/code-review/SKILL.md:188-195`는 `--module fsd,type`을 지원한다고 설명한다. 그러나 module discovery와 prompt 구성은 모든 numbered non-00 모듈을 항상 포함한다 (`SKILL.md:69-81,103-116`). 인자 파싱, 이름→파일 매핑, 잘못된 module 처리 규칙이 없다.

### P0-6. full workflow에서 `00-rule.md`를 독립 pass에서 제외해야 한다

full workflow는 `[0-9]*.md` 각각을 필수 모듈로 취급하면서 (`skills/code-review-full/SKILL.md:24-33`), 동시에 `00-rule.md`를 모든 모듈에 전달하는 공통 규칙으로 정의한다 (`:26-28`). `00-rule.md`를 별도 agent로도 실행하는지 모호하다.

default와 동일하게 `00`은 shared context로만 사용하고, per-module pass는 numbered non-00만 실행한다고 명시해야 한다.

### P0-7. `fast.md`의 실제 드리프트를 원본과 맞춰야 한다

확인된 차이는 다음과 같다.

- provider-only API contract의 원본 severity와 fast severity 불일치: `16-api-contract.md:63-78` 대비 `fast.md:132-136`
- server-only concurrency 규칙의 원본 severity와 fast severity 불일치: `17-concurrency.md:51-67` 대비 `fast.md:138-142`
- dangerous-change trigger와 read-only/UI/순수 계산 제외 조건이 fast에서 누락: `18-dangerous-change.md:7-18` 대비 `fast.md:144-148`
- React performance trigger와 작은 정적 UI 제외 조건이 fast에서 누락: `14-react-performance.md:12-22` 대비 `fast.md:118-122`

수동 압축본을 계속 유지한다면 CI에서 최소한 ID, severity, applicability qualifier를 검증해야 한다.

### P0-8. 잘못된 cross-reference를 수정해야 한다

`review-rules/04-state.md:147`은 optimistic rollback을 `17-8`로 참조한다. 실제 rollback 규칙은 `review-rules/17-concurrency.md:43-47`의 `17-4`이며, `17-8`은 안전 증거 요구 규칙이다.

## 4. P1 — React 관점 추가 필요 사항

### 4.1 RSC와 Server/Client 경계

현재 규칙에는 다음 항목이 없다.

- `'use client'`가 만드는 transitive client dependency 경계
- `'use server'`가 Server Component가 아니라 Server Function을 표시한다는 구분
- Client Component로 전달되는 props의 직렬화 가능성
- server-only import·secret이 client bundle로 유출되는 경로
- Server Function의 authorization과 runtime validation

RSC 지원 framework에서만 활성화되는 별도 applicability 조건이 필요하다.

### 4.2 Hydration 규칙 보완

현재 `03-react-rules.md:57-69,133-140`은 random/time과 DOM id를 다루지만 다음이 빠져 있다.

- 서버 출력과 첫 client render의 동일성
- browser API/locale/timezone 분기
- 외부 store `getServerSnapshot` parity
- suppressHydrationWarning 남용

### 4.3 Suspense·Transition·비동기 UI

`14-react-performance.md:61,63-71,88-93`은 lazy fallback과 입력 반응성을 다루지만 다음이 필요하다.

- controlled input state를 transition으로 직접 갱신하지 않기
- `isPending`을 통한 사용자 피드백
- `await` 이후 transition 처리와 async ordering
- `useDeferredValue`가 debounce/cancellation을 대체하지 않는다는 구분
- Suspense와 Error Boundary 배치, reveal ordering, 기존 화면 보존

### 4.4 `useSyncExternalStore` 계약

현재 `03-react-rules.md:133-140`은 직접 effect 구독과 tearing만 다룬다. 다음 protocol 검사가 추가돼야 한다.

- `subscribe` cleanup과 참조 안정성
- unchanged data에서 `getSnapshot` identity 유지
- mutable store의 cached immutable snapshot
- SSR `getServerSnapshot`과 client 초기 snapshot 일치

### 4.5 React 19·Compiler 조건부 규칙

React 19+ 프로젝트에 한해 다음을 다룰 수 있다.

- `use`, `useActionState`, `useOptimistic`, `useFormStatus`, form Actions
- async Action의 순서 역전과 pending/error 상태
- ref-as-prop과 기존 `forwardRef` 패턴의 버전별 적용
- React Compiler 활성화 여부에 따른 memoization 리뷰

README에 최소 지원 React 버전과 version-gated rule 표를 두는 것이 필요하다.

## 5. P1 — TypeScript 관점 추가 필요 사항

`02-type.md`는 narrowing과 discriminated union의 기본은 포함하지만 (`02-type.md:67-95`), 다음 영역이 부족하다.

1. **compiler config awareness**
   - `strict`, `strictNullChecks`, `useUnknownInCatchVariables`
   - `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`
2. **trust boundary**
   - network/storage/env/DOM/server-client boundary에서 `unknown` 수신과 runtime parse
   - generated type과 runtime schema drift
3. **assertion safety**
   - non-null assertion, double assertion, assertion function 구현 검증
   - `satisfies`는 runtime validation이 아니라는 구분
4. **module semantics**
   - `import type`, `export type`, `verbatimModuleSyntax`
   - bundler/Node host에 따른 module 설정 차이
5. **generic·variance**
   - type parameter가 입력·출력 관계를 실제로 보존하는지
   - `strictFunctionTypes`, method/function-property callback 차이
6. **React API typing**
   - ref element 일치, callback ref cleanup
   - polymorphic `as` component의 intrinsic prop 충돌
   - event의 `target`과 `currentTarget` 구분

TypeScript 6의 새로운 기본값은 TS 5 프로젝트에 보편 규칙으로 강제하지 말고 실제 `tsconfig`와 compiler version을 먼저 확인해야 한다.

## 6. P1 — 아키텍처와 운영 보완

### 6.1 공통 workflow contract 추출

base resolution, rule path, read-only, autofix, test scope, report naming이 여러 SKILL 문서에 복제돼 다시 불일치가 생겼다. 공통 계약을 하나의 문서로 두고 각 workflow는 mode-specific 차이만 선언하는 편이 안전하다.

특히 full workflow는 default와 같은 base fallback 및 사용자 지정 range 우선순위를 명시해야 한다 (`skills/code-review-full/SKILL.md:18-23`).

### 6.2 테스트 정책 수정

현재 공통 규칙은 리뷰 대응용 test/mock 추가를 광범위하게 금지하고 (`review-rules/00-rule.md:19-25`), 일반 리뷰에서 test 변경을 제외한다 (`:41-46`). 의미 없는 review-padding test와 정상적인 regression test를 구분해야 한다.

- 변경된 테스트는 affected behavior의 증거로 리뷰할 수 있어야 한다.
- concrete regression path가 있을 때 테스트 추가를 권고할 수 있어야 한다.
- mock이 production dependency를 우회하거나 assertion이 무의미한 경우만 문제로 본다.

### 6.3 project-specific profile 활성화

FSD/Electron/Tailwind/Three.js는 header 조건이 생겼지만, 자연어 해석에 의존한다. TanStack Query 규칙은 독립 applicability 없이 여러 모듈에 섞여 있다.

경량 catalog에 다음 metadata를 두는 방식을 권장한다.

- rule ID와 상대 경로
- default/full/fast 포함 여부
- framework/profile 조건
- React·TypeScript 최소 버전
- specialist/focus tag

Markdown 본문은 정본으로 유지하고 문서 생성 DSL은 도입하지 않는 것이 적절하다.

## 7. 자동 검증과 CI

현재 저장소에는 문서 정합성을 보장하는 자동 검사가 없다. 이번 변경에서 실제 cross-reference와 fast drift가 남은 점을 고려하면 후속 작업이 아니라 품질 보증의 일부로 보는 것이 타당하다.

최소 validator가 확인해야 할 항목:

1. numbered rule 파일의 연속성
2. 파일 prefix와 rule ID 일치
3. duplicate rule ID
4. Markdown cross-reference 대상 파일·규칙 존재 여부
5. README inventory와 실제 파일 일치
6. skill이 참조하는 workflow-name·rule path 유효성
7. `fast.md`의 ID·severity·applicability qualifier 동기화
8. hard-coded home path 재도입 방지
9. manifest 필수 필드와 plugin package smoke check

대표 fixture로 다음 workflow 계약을 검증해야 한다.

- explicit range와 base fallback
- empty diff
- read-only/no-file 요청
- default module filter
- full의 00 shared-context 처리와 module failure
- special pass의 SKIPPED 조건
- test 변경 포함 정책
- profile/version gating

검증은 PR CI에서 실행하고 실패 시 merge를 차단해야 한다.

## 8. 권장 수정 순서

1. **규칙 정확성:** TypeScript 절대 규칙, React false positive, StrictMode 문구 수정
2. **workflow 안전성:** read-only/autofix/report, `--module`, full의 00 처리 수정
3. **정합성:** `04-state.md` cross-reference 및 `fast.md` severity/qualifier 동기화
4. **현대 React 보완:** RSC, hydration, transition, external store, React 19/Compiler gating
5. **TypeScript 보완:** tsconfig-aware trust-boundary 중심으로 `02-type.md` 재구성
6. **profile 분리:** FSD/Electron/Tailwind/TanStack/Three.js applicability 명시
7. **자동화:** catalog/validator/fixture/CI 추가

## 9. 재검토 체크리스트

- [ ] `02-type.md`가 valid escape hatch와 local inference를 자동 ERROR로 처리하지 않는다.
- [ ] `use`, StrictMode, effect cancellation, dependency identity, memoization 규칙이 React 버전과 실제 위험을 기준으로 한다.
- [ ] RSC/React 19/Compiler 규칙에 applicability 조건이 있다.
- [ ] 모든 workflow가 read-only/no-file 요청을 최우선으로 따른다.
- [ ] `/code-review --module`이 실제 module selection에 반영된다.
- [ ] full review가 `00-rule.md`를 독립 module agent로 실행하지 않는다.
- [ ] `04-state.md`가 optimistic rollback을 `17-4`로 참조한다.
- [ ] `fast.md`가 canonical severity와 제외 조건을 보존한다.
- [ ] 테스트 변경을 일률적으로 배제하지 않는다.
- [ ] validator와 CI가 inventory·ID·cross-reference·fast drift를 검사한다.

## 10. 최종 판정

이번 개편은 이전보다 React 전용 리뷰 체계의 형태를 훨씬 잘 갖췄다. 특히 모듈 인벤토리, 경로 탐색, rule ID, render purity, effect 목적, React 성능 분리는 유효한 개선이다.

그러나 TypeScript 핵심 규칙과 React false-positive가 남아 있고, `fast.md`·workflow 계약·cross-reference를 검증할 자동 장치가 없다. 현재 상태로는 **"구조 개편은 성공했지만 기술적 정확성과 운영 일관성은 미완료"**로 판단한다. P0 항목 수정 전에는 React/TypeScript 리뷰 규칙의 신뢰성을 보장하기 어렵다.
