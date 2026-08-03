# Fast Code Review Rules (압축본)

> **Sync note**: 숫자 prefix 모듈은 현재 `00` ~ `20` 이며 빈 번호가 없다. 모듈을 추가·삭제·재배치하면 이 문서의 해당 섹션도 같이 고쳐야 한다. 압축 과정에서 **원본의 예외 조항을 빠뜨리지 않는다** — 예외를 지우면 오탐이 된다.

이 문서는 숫자 prefix 상세 모듈에서 **high-signal 지적 기준만** 추려낸 압축본이다. 오직 `/code-review-fast`에서만 사용한다. 상세 리뷰가 필요하면 `/code-review` 또는 `/code-review-full`을 쓴다.

`exception.md`, `props.md`, `math.md` 같은 특수 모듈은 fast 리뷰에 포함되지 않는다.

## Severity

- 🔴 ERROR — 머지 전 필수 수정 (런타임 버그, 경계/원칙 위반)
- 🟡 WARNING — 수정 권장 (가독성, 일관성, 패턴 이탈)
- 🔵 INFO — 개선 제안

## 파일별 1개 선택 규칙

각 변경 파일에 대해:

1. diff 라인 또는 그 변경 때문에 직접 깨진 인접 구조에서 **확인된** 이슈만 모은다.
2. severity가 가장 높은 것을 고른다.
3. 동점이면 다음 순서로: 위험 변경(18) → API 계약(16) → 동시성(17) → 삭제 회귀(20) → React 규칙(03) → 아키텍처 경계(01) → 타입(02) → 상태/이펙트(04) → 접근성(12, 사용 경로가 막힐 때) → 나머지.
4. 파일당 최대 1개만 출력한다.
5. 위반 없는 파일은 언급하지 않는다.

규칙 ID는 `00-rule.md` 00-2의 표기 규칙을 따른다.

---

## 00. 공통

- 🔴 리뷰 통과용 mock/test/stub 신규 추가 금지 — "리뷰 우회" 신호
- 🔴 같은 개념을 `user`/`userData`/`currentUser`로 혼용
- 🔴 리뷰는 read-only가 기본. lint는 `--fix` 없이 실행하고, 자동 수정과 코드 수정은 사용자가 요청했을 때만 (00-9)
- 🔴 사용자가 read-only/파일 수정 금지/텍스트 응답만을 요청하면 리뷰 문서도 만들지 않는다 (00-9 > 00-5)
- 🟡 "편해서 shared/common에 둠" 같은 임시 배치는 위반 후보

## 01. FSD 아키텍처

🔴 — 레이어 방향(`app → pages → widgets → features → entities → shared`) 역행·순환, `import type`을 통한 우회 / 슬라이스 내부 경로 직접 import / wildcard re-export / 동일 레이어 cross-import / `index.ts`로 private 구현 누출 / `features/*` 이름이 명사형(동사구 강제)

🟡 — 역할 배치 오류: app에 도메인 로직, pages에 재사용 블록, features에 `*-api.ts` 정의 파일(정의는 entities, 호출만 features), entities에 라우팅·하드코딩 URL, shared에 도메인 종속 코드. Electron: renderer에서 `fs`/`path` 직접 사용, main/preload 직접 import

🔵 — 단수/복수 혼용, 슬라이스명-segment 충돌(`features/ui`)

## 02. 타입 안전성

🔴 — `any`가 exported 타입·public 시그니처·앱 내부로 전파, `@ts-ignore`, 근거 없는 `as`, `as unknown as T`, `[key: string]: any` Props

🟡 — 사유·제거 조건 없는 `@ts-expect-error`, exported 컴포넌트 Props가 인라인이라 참조할 이름 없음, contextual typing이 끊긴 자리(핸들러를 별도 선언)에 이벤트 타입 미명시, 인라인 타입·유틸리티 중첩·무명 유니온이 커져 의미를 못 읽음(3필드·3단·5멤버는 신호), 같은 인라인 타입 2곳+ 복제, API nullable인데 Props non-optional, snake_case↔camelCase 변환 누락, null narrowing 없이 접근, exhaustive check 누락, 판별자 필드 혼용, 제네릭이 입출력 관계를 보존하지 않거나 본문이 요구하는 capability가 제약에 없음

**지적하지 않음** — 경계에 격리되고 검증된 타입으로 반환되는 `any`, 사유·제거 조건이 붙은 `@ts-expect-error`, 파일 내부 local 컴포넌트의 인라인 Props, JSX 인라인 핸들러의 이벤트 타입 생략, 관계만 보존하면 되는 제약 없는 `T`

## 03. React 규칙

🔴 — 조건문·루프·early return 이후·일반 함수에서 hook 호출 / 렌더 중 **다른 컴포넌트** setState·무조건 setState·외부 변이·`Math.random()`·`Date.now()` / 렌더 중 생성한 값을 `key`로 사용 / props가 계속 진실의 출처인데 `useState`에 복사한 뒤 `useEffect`로 동기화

🟡 — 정렬·삭제가 있는 리스트에 index key, 외부 시스템 동기화가 아닌 effect(핸들러나 렌더 중 계산으로 옮겨야 함), ref/state 오용, 외부 스토어를 effect+state로 구독(`useSyncExternalStore` 필요), `useId` 없이 만든 DOM id, prop 이름이 소유권 계약을 드러내지 않는데 동기화도 없음

**지적하지 않음** — 조건부 `use(resource)` 호출(React 19+에서 허용), 자기 state를 이전 props와 비교해 조정하는 guarded render-phase adjustment(종료 조건 있고 부수효과 없음), `initialX`/`defaultX`로 받아 이후 동기화하지 않는 uncontrolled 패턴, 의도적 리셋을 위한 `key` 변경

## 04. 상태 & 사이드이펙트

🔴 — effect 클린업 누락(구독/타이머/리스너) / 비동기 결과 반영에 stale-result 방어가 **하나도** 없음 / effect가 읽는 reactive value가 의존성에서 누락, 빈 `[]`인데 변하는 값을 읽음 / 로딩·에러·데이터 상태 미반영, 경쟁 조건, 미처리 rejection / 한 effect에 무관한 작업 혼합

🟡 — `exhaustive-deps` suppression에 근거 없음, 매 렌더 새로 만들어지는 참조를 의존성에 넣어 실제로 재실행·재구독 유발, 상태 라이브러리 혼용, 서버/클라이언트 상태 경계 불명확, Context value가 매 렌더 새 객체이고 **그 때문에 실제 리렌더 비용이 발생**, 하나의 Context에 값·액션·UI 상태 혼재, stale closure(`setCount(count+1)`), 직접 변이(`push`), 연관 state 분리로 인한 동기화 버그

**지적하지 않음** — stale-result 방어가 `AbortController`가 아니라 `ignore` 플래그·request token·쿼리 라이브러리 위임으로 되어 있는 경우, 취소가 불필요한 effect(구독·타이머)에 abort 부재, 참조가 이미 안정적인 객체 의존성, React Compiler가 켜진 프로젝트에 수동 memoization 추가 요구

## 05. 함수 & 컴포넌트 구조

🔴 — 함수 20줄 초과(추상화 수준 혼재/중첩 3단+/독립 작업 3개+) / 컴포넌트 150줄 초과 + 관심사 혼재 / 한 파일에 export 컴포넌트 2개+

🟡 — if-else 중첩 2단+ → early return, 매개변수 3개 초과, 훅 반환값 10개+, 훅 이름으로 역할 유추 불가, 2곳+ 동일 로직 복사, 핸들러 5줄 초과

## 06. JSX

🔴 — `{count && <X/>}`에서 `0`/`''`가 그대로 렌더됨

🟡 — 삼항 2단+ 중첩, 조건부 블록 10줄+, `map` 콜백 10줄+, `map` 안 hook 호출, Props 4개+ 한 줄, 인라인 함수 5줄+, 불필요 Fragment, 무분별한 `{...props}`, 컴포넌트 본문 안에서 컴포넌트 정의

## 07. 네이밍 & 주석

🔴 — 모호한 이름(`d`, `temp`, `data`, `info`, `item`, `stuff`) — **단, `Result<T, E>` 문맥의 `result`는 예외** / 지나치게 긴 이름 / boolean `is/has/should/can` 누락(HTML 표준 속성명은 예외) / 핸들러 `handle`·콜백 props `on` 누락 / 같은 개념 이름 혼용

🟡 — 컴포넌트명이 내용 설명 못 함, `Container`/`Wrapper` 단독, `use` 접두어 없는 커스텀 훅, `{Component}Props` 미준수, 파일 네이밍 혼용, 불필요 주석·미연결 TODO, 필수 주석 누락(비자명 규칙, 복잡한 정규식, workaround 이유+제거 시점)

## 08. 상수 & 매직값

🔴 — 의미 불분명 숫자 리터럴(타임아웃·재시도·페이지 크기·z-index) / 동일 상수값이 2+ 파일에 각각 선언(Query Key, endpoint, localStorage key)

🟡 — 매직 문자열 산재, 상태값 문자열 비교 → 유니온, 사용자 노출 문구 하드코딩 → i18n 권장(로그·개발자 에러·식별자 문자열은 예외), 프로젝트가 정한 상수 위치 규칙 이탈

## 09. Import & Dead Code & 일관성

🔴 — dead code(도달 불가·미사용·주석 블록·비활성 flag) / 같은 목적의 이전·새 구현 공존 / 패턴 불일치(같은 성격 컴포넌트 구조 상이, useQuery·fetch 혼용) / `react-refresh/only-export-components` suppression

🟡 — import 순서·미사용 import, named/default 혼용, 한 파일 5+ export, 로직 없는 wrapper, 빈 effect/catch, 에러 표시 표면 불일치, 이중 부정, 5단+ destructuring, `!!value`, 3+ 조건 논리식

## 10. 개발 원칙

🔴 — `10-SSOT`, `10-SRP`, `10-SoC`, `10-FailFast`(빈 catch, 미검증 입력), `10-Immutability`

🟡 — DRY, KISS, YAGNI, OCP, ISP, LoD, PoLA, CQS, Composition, Encapsulation, Defensive, DataPresentation, LeastPrivilege, Colocation, Explicit, CoC 중 해당하는 것

🔵 — DIP, Idempotency, Transparency, Robustness, TellDontAsk, UniformAccess, NoPrematureOpt, Parsimony

## 11. 스타일링 *(Tailwind 프로젝트 전용)*

🔴 — 정적 값에 `style={{}}` / 색상·배경·border·shadow에 hex 하드코딩 또는 Tailwind 기본 팔레트(`gray-800`)

🟡 — 유한 조건 분기를 인라인 style로, 단순 레이아웃 때문에 새 `.css`, `!important`, `@apply` 남용

## 12. 접근성

🔴 — 클릭 가능한 `div`/`span`으로 button/link 흉내 / keyboard activation 경로 없음 / modal·dialog·route transition에 focus 진입·복원·trap 없음 / icon-only button·form control·dialog에 accessible name 없음 / error text가 control과 연결되지 않거나 조용히 추가됨 / 의미 있는 image·icon·chart·색상 전용 상태에 텍스트 대안 없음 / `aria-*`가 실제 UI 상태와 불일치

🟡 — reduced-motion 대안 없는 애니메이션, diff에서 직접 보이는 contrast 저하

## 13. DX

🔴 — 이름만으로 역할 파악 불가, public API 사용법 불명확 / 한 군데 수정에 여러 파일을 암묵적으로 알아야 함, side effect 경계 숨김

🟡 — 같은 기능군의 호출 패턴 제각각, 신규 코드 추가 위치가 구조상 모호, 파일 위치 부적합

## 14. React 성능

🔴 — 상한이 열린 대형 리스트를 가상화·페이지네이션 없이 전량 렌더

🟡 — 라우트/모달/에디터/차트를 정적 import(코드 스플리팅 부재), 입력마다 무거운 렌더를 동기 실행(`useDeferredValue`/`useTransition` 미검토), 렌더 중 대형 정렬·정규식·`Intl` 인스턴스 반복 생성, 이미지 크기 미지정·lazy 미적용, Suspense 경계 과대·부재

## 15. 알고리즘 복잡도

🔴 — 중첩 루프 + `.find`/`.includes`(O(N²)) → Map/Set / 같은 컬렉션 반복 선형 탐색 / 루프 내 누적 spread / 재계산·memo 없는 DP 후보 / N+1 I/O(루프 내 await) → 배치 또는 `Promise.all`

🟡 — 자료구조 부적합, min/max에 전체 sort, 원본 배열 변이하는 `sort()`, 큰 데이터의 불필요한 중간 배열, 루프 내 정규식 생성, 문자열 누적, 재귀 깊이 N

**지적 원칙**: 실제 데이터 규모 고려. 10건 배열의 O(N²)는 대부분 문제 아님.

## 16. API 계약

🔴 — 타입만 바꾸고 runtime parser/schema/generated client/mapper가 그대로 / 응답 shape 변경인데 소비 측 컴포넌트·훅 미갱신 / query key 변경인데 `invalidateQueries` 호출부 미갱신 / route·param·query default 의미 변경으로 기존 URL이 깨짐

🟡 — (제공자일 때) field 제거·rename·required화, status/error body 의미 변경, IPC/event payload 변경, env·config·public export rename에 fallback 없음, breaking 변경에 versioning/migration 증거 없음

## 17. 동시성 & 멱등성

🔴 — save/delete/payment/mutation이 double click·rapid re-entry·네트워크 retry·중복 이벤트 전달로 두 번 실행 가능한데 방어 없음 / mutation이 effect·렌더 경로에 있어 재실행 때 함께 실행됨(핸들러로 이동) / 느린 이전 응답이 최신을 덮어씀 / 언마운트·route change 후에도 이전 async work가 결과를 publish

**주의**: StrictMode는 click 등 사용자 이벤트를 두 번 dispatch하지 않는다. 사용자 경로 중복의 원인으로 적지 않는다.

🟡 — optimistic update 실패 시 rollback 없음. (서버 측 코드일 때) 멱등성 키 부재, non-idempotent retry, read-modify-write에 트랜잭션·버전 가드 없음, replay-unsafe consumer

## 18. 위험 변경

🔴 — 클라이언트 gating만 바꾸고 서버·main 권한 검사 그대로 / 삭제·덮어쓰기·마이그레이션에 확인·롤백·복구 경로 없음 / 금액·수량 계산 변경에 검증 없음 / 토큰·개인정보가 로그·URL·클라이언트 번들에 노출

🟡 — feature flag 기본값 변경에 롤아웃 계획 없음, env 키 rename에 fallback 없음, 위험 흐름 변경인데 안전 증거가 하나도 없음

## 19. 의도 & 선택 근거

🔴 — 문제와 해결 방식이 어긋남(단순 요구에 과한 추상화 / 복잡한 요구에 임시 우회) / 핵심 트레이드오프가 숨겨짐 / workaround인데 이유·제거 시점 없음

🟡 — 왜 이 코드가 필요한지 파악 불가, 표준 패턴으로 충분한데 커스텀 구조, React 기본 동작을 수동 구현으로 대체하고 근거 없음

## 20. 삭제 회귀

🔴 — 삭제된 production export/function/type/constant/schema에 대체 경로·이동·호출부 갱신 증거 없음 / 기능은 유지되는데 구현만 사라짐 / effect cleanup·의존성 항목·`key`·Suspense 경계 삭제

🟡 — test/mock/fixture 전용 삭제는 fast 리뷰에서 제외. 전체 저장소 탐색 대신 삭제된 심볼의 targeted reference check만.

---

## 출력 형식

| 심각도 | 파일 | 규칙 | 핵심 이슈 | 이유 | 개선 방향 |
|--------|------|------|----------|------|----------|
| 🔴/🟡/🔵 | path/to/file | 03-1 | 가장 중요한 1개 | 왜 중요한지 | 짧은 수정 방향 |

**원칙**

- 파일당 이슈는 최대 1개 (severity 높은 것)
- 위반 없는 파일은 상세 표에 포함하지 않음
- 단순 스타일·반복 지적·영향 작은 코멘트는 생략
- diff에 없는 기존 코드 지적 금지, 추측 금지
