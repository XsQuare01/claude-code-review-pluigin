# Fast Code Review Rules (압축본)

> **Sync note**: 숫자 prefix 모듈은 현재 `00` ~ `21` 이며 빈 번호가 없다. 모듈을 추가·삭제하면 이 문서의 해당 섹션도 같이 고쳐야 한다. **번호 모듈의 조항을 고치면 이 문서의 같은 섹션도 같은 PR에서 고친다** — 2026-08-13부터 2026-11-10까지 모듈이 여러 번 고쳐지는 동안 이 문서는 따라가지 않았고, 원본이 좁히거나 다른 조항으로 옮긴 판정(08-3, 09-4, 12-5 등)이 옛 모양 그대로 fast 리뷰에 쓰였다. 2026-11-10에 01~21을 원본에서 다시 썼다.
>
> 압축할 때 원본과 **반드시 일치시켜야 하는 것**이 있다. 어긋나면 fast 리뷰는 원본과 다른 판정을 내리는 별개의 규칙 체계가 된다.
>
> 1. **조항 ID** — 항목마다 끝에 원본 조항 ID를 단다(`(08-3)`). 원본의 모든 조항이 이 문서에 ID로 있다. ID가 없으면 리뷰어가 리포트의 `규칙` 칸을 추측으로 채운다.
> 2. **적용 가능성 + 영향도 보정** — 원본의 applicability, exception, typical impact calibration을 유지한다. 원본 모듈의 표기 이모지는 참고 보정값일 뿐이고, fast가 내는 지적의 최종 severity는 함께 받는 `00-rule.md`의 두 축 파생으로 정한다.
> 3. **적용 조건(Trigger)** — 원본에 Trigger 섹션이 있으면 압축본에도 적용 조건과 제외 조건을 남긴다. 조건을 지우면 적용 대상이 아닌 코드까지 지적한다.
> 4. **예외 조항과 담당 이동** — 원본의 "지적하지 않음"과 "그 경우는 다른 조항이 맡는다"를 빠뜨리지 않는다. 예외를 지우면 오탐이 되고, 담당 이동을 지우면 원본이 한 조항으로 모은 결함을 두 조항으로 낸다.

이 문서는 숫자 prefix 상세 모듈에서 **high-signal 지적 기준만** 추려낸 압축본이다. 오직 `/code-review-fast`에서만 사용한다. 상세 리뷰가 필요하면 `/code-review` 또는 `/code-review-full`을 쓴다.

fast의 리뷰어는 이 문서와 함께 `00-rule.md`(등급·근거·위치)와 `correctness.md`(변경이 의도대로 동작하는가)를 받는다. 이 문서는 **무엇이 규칙 위반인가**만 담당한다. `exception.md`, `props.md`, `math.md` 같은 특수 모듈은 fast 리뷰에 포함되지 않는다.

## Severity

- 지적의 등급은 함께 받은 `00-rule.md`의 **Severity 기준(영향도 × 확신도 파생)** 으로만 정한다. 규칙 옆의 🔴/🟡/🔵를 지적에 그대로 복사하지 않는다.
- 규칙 옆 고정 이모지는 그 규칙 위반이 **대체로** 어느 영향에 해당하는지의 **비구속적 보정 마커**다. applicability와 typical impact를 압축본에 유지하기 위한 참고값이지, 최종 등급 결정권이 아니다. 이름·길이·상수 배치·스타일 규칙 옆 🔴도, 그 지적이 닫힌 다섯 항목(사용자 오동작·데이터 손상·보안 노출·빌드/테스트 실패·계약/복구 경로 파손) 중 하나를 지목하지 못하면 영향 낮음이다.

## 선별 규칙

1. diff 라인 또는 그 변경 때문에 직접 깨진 인접 구조에서 **확인된** 지적만 모은다.
2. 지적마다 두 축을 판정한다. **영향 높음만 낸다** — 확신 높음이면 🔴, 확신 낮음이면 🟡이다.
3. 영향이 높을 수 있지만 부재·가능성 주장을 확인하지 못했으면 지적이 아니라 `확인 필요`로 낸다 (00-11).
4. **영향 낮음은 내지 않는다.** 사실이어도 생략하고, 지적이 적다고 그런 지적으로 빈자리를 채우지 않는다. 사용자가 낮은 영향까지 보자고 한 실행만 예외다.
5. 개수 상한은 없다. 같은 파일의 독립적인 결함은 각각 낸다. 같은 원인이 여러 위치에 드러나면 한 지적으로 묶고 위치를 모두 적는다. 위치가 가깝다는 이유만으로 다른 결함을 묶지 않는다.
6. 깊게 볼 순서: 위험 변경(18) → RSC 경계(21, 비밀 유출·권한) → API 계약(16) → 동시성(17) → 삭제 회귀(20) → React 규칙(03) → 상태/이펙트(04) → 타입(02) → 아키텍처 경계(01) → 접근성(12, 사용 경로가 막힐 때) → 나머지. 이 순서는 시간을 어디에 먼저 쓸지 정할 뿐이다 — 뒤 순서의 영향 높은 결함도 낸다.
7. 위반 없는 파일은 언급하지 않는다.

규칙 ID는 `00-rule.md` 00-2의 표기 규칙을 따르고, **이 문서의 항목 끝 괄호에 적힌 ID만** 쓴다. 맞는 ID를 찾지 못하면 ID를 지어내지 말고, 의도 대비 동작 결함이면 `CR-{순번}`으로 낸다.

**섹션 읽는 법** — `적용 조건`(성립할 때만 그 섹션을 적용한다) → `영향 높음`(이 모듈에서 무엇이 있어야 영향 높음인가) → 이모지 묶음(원본 조항 제목의 보정 마커와 항목, 끝 괄호가 조항 ID) → `지적하지 않음`(예외와 다른 조항으로의 담당 이동) → `지적 원칙`(탐색 범위와 판정 절차). `(NN 공통)`은 특정 조항이 아니라 그 모듈 전체에 걸리는 기준이므로 `규칙` 칸에 쓰지 않는다.

---

## 00. 공통

fast 리뷰어는 `00-rule.md`를 직접 받는다. 리뷰 우회용 테스트(00-1), 변경된 테스트를 증거로 쓰기(00-3), 위치 표기(00-10), 부재 주장의 근거(00-11), read-only(00-9), 리포트 골격(00-2)은 그 문서를 따른다 — 여기에 옮겨 적지 않는다. 옮겨 적은 사본은 원본이 바뀔 때 함께 낡는다.

## 01. FSD 아키텍처

**적용 조건**: FSD(Feature-Sliced Design)를 쓰는 React 프로젝트에만 — FSD가 아니면 모듈 전체를 적용하지 않는다. 01-5는 renderer/preload/main 프로세스 경계가 실제로 있는 프로젝트에만 적용하고, 단일 웹 앱에서는 지적하지 않는다.

**영향 높음**: 레이어 경계·public API·process seam 위반이 실제 오동작·외부 파손·검증 실패로 닫힐 때만. 역할 배치·segment 위치·구조 단순화·네이밍 같은 변경 비용 문제에 머물면 영향 낮음.

🔴 — `app → pages → widgets → features → entities → shared` 역방향 import·순환 의존(type-only import 포함) (01-1) / 슬라이스 내부 경로 직접 import(외부 접근은 `index.ts`로만), wildcard re-export, 크로스 레이어에 상대 경로·슬라이스 내부에 alias, named export라도 `index.ts`로 private helper·internal hook·내부 구현 공개 (01-2) / 같은 레이어(`widgets`·`features`·`entities`) 슬라이스 간 직접 import — 해결은 entities/shared 이동·widget/page hooks 합성·함께 바뀌는 책임의 병합이고, feature끼리 병합은 제안하지 않음(01-9) (01-3) / `features/*` 이름이 동사구가 아님(명사·도메인 객체명·`features/<entity-name>`), 한 feature에 여러 동사 → 행위 단위 분할 (01-9)

🟡 — 레이어 이름과 실제 책임 불일치(import 방향이 맞아도 위반): app에 도메인 로직·화면 구현, pages에 재사용 블록·도메인 액션, 범용 widget의 entities 조회(props only, 도메인 특화 widget만 조회 훅 허용)·feature public API를 거치지 않은 도메인 상태 변경, features에 조회·표현 전용 코드나 `*-api.ts` 정의(정의는 mutation 포함 entities/api, features는 mutation 호출만), entities에 라우팅·하드코딩 URL·단일 feature 전용 로직, shared에 도메인 종속·화면 전용·"당장 편해서" 올린 코드 (01-4) / segment 금지 내용(`ui`의 비즈니스 로직·직접 API 호출, `model`의 UI·서버 통신, `api`의 도메인 판단, `config/context`의 런타임 비즈니스 로직 등), 같은 슬라이스 상수가 `config`와 `lib`에 섞임 → 한쪽으로 모으라고 제안 (01-6) / 상태 소유 위치 — 서버 캐시는 `entities/*/api|hooks`, 클라이언트 UI 상태는 `shared/store`·`features/*/model`, 3개+ feature가 공유하거나 로직이 커진 entity 상태는 feature로 (01-7)

🟡 (Electron 전용) — renderer의 `fs`/`path` 직접 사용·main/preload 직접 import, preload의 renderer feature 내부 경로 import, preload/shared adapter로 감싸지 않은 raw IPC, cross-process 공유 위치 밖의 IPC 타입·`unknown` 남용·에러 삼킴 (01-5)

🔵 — 단수/복수 혼용, 슬라이스명-segment 충돌(`features/ui`), 자기 index 재import 순환 (01-8)

**지적하지 않음** — Redux 그룹 폴더에서 같은 그룹 공용 `model/`의 상대 경로 import(하위 feature 간 직접 import는 위반) (01-3) / 프로젝트가 일관되게 지키는 상수 배치 관례(`lib/constants.ts` 등)와 그 관례를 따르는 새 상수 — segment 표는 FSD 정본 배치일 뿐 유일한 정답이 아니다. 런타임 비즈니스 로직·상태를 보유한 모듈은 상수가 아니므로 이 예외 밖이고 표대로 본다 (01-6) / IPC 채널·payload 호환성은 16, 권한 경계는 18이 맡는다 (01-5) / 상태 관리 구현(클린업·경쟁 조건·리렌더)은 04가 맡는다 (01-7)

**지적 원칙**: 상수는 위치 선택이 아니라 혼용만 지적 — 관례를 판단할 근거가 diff 안에 없으면 지적 대신 `확인 필요` (01-6)

## 02. 타입 안전성

**리뷰 전 확인**: `tsconfig.json`(상속 체인 포함)과 TypeScript 버전을 먼저 확인하고 그 설정 기준으로 판정한다. `strict`/`strictNullChecks`·`useUnknownInCatchVariables`·`noUncheckedIndexedAccess`·`exactOptionalPropertyTypes`·`noImplicitReturns`·`strictFunctionTypes`(02-13)·`verbatimModuleSyntax`(02-12)가 꺼져 있으면 컴파일러가 안 잡는 것(null 접근 전반·catch `e`의 `e.message`·인덱스 접근 후 바로 사용·optional에 명시적 `undefined`·일부 분기만 반환·콜백 반공변·타입 import 소거)을 리뷰가 대신 본다. 새 버전 기본값·문법을 이전 버전 프로젝트에 요구하지 않는다 — 없는 기능 요구는 오탐 (02-11)

**영향 높음**: 런타임 에러·검증 실패·타입 시스템 무력화가 현재 변경에서 직접 닫힐 때만. 타입 표현 정밀도·잠재적 버그 가능성·유지보수성에 머물면 영향 낮음.

🔴 — 근거 없는 단언(`as User` — narrowing·런타임 검증 없음), `as unknown as T`, catch-all Props(`[key: string]: any`), `any`가 exported 타입·public 시그니처·앱 내부로 전파, `@ts-ignore`(→ `@ts-expect-error`) (02-1) / 신뢰 경계(네트워크·WebSocket·SSE, storage·IndexedDB·쿠키, URL·hash·postMessage·확장 메시지, env·런타임 config·feature flag, 파일·클립보드·드래그앤드롭, Electron IPC·서버→클라이언트 직렬화) 값에 검증 없이 단언·제네릭 인자로 타입을 붙여 사용(`await res.json() as User`, `JSON.parse(raw) as Config`), `localStorage` 값을 파싱만 하고 shape 확인 없이 state·store에 주입, env·config 값을 `string`으로 단정(없으면 `undefined`) (02-9) / non-null `!`의 근거(앞선 검사·불변식·초기화 순서)가 코드에 없음, assertion function(`asserts x is T`) 본문이 약속한 검사를 하지 않음, `satisfies`·타입 선언을 런타임 검증으로 오해(컴파일 시점에만 확인) (02-10) / `ref` 엘리먼트 타입이 실제 부착 대상과 달라 `current` 접근이 런타임에 어긋남 (02-14)

🟡 — 사유·owner·제거 조건 없는 `@ts-expect-error` (02-1) / exported 컴포넌트의 인라인 Props라 참조할 이름 없음, children 타입이 실제 사용과 어긋남, contextual typing이 끊긴 핸들러(따로 선언해 `e`가 implicit any)에 이벤트 타입 미명시 (02-2) / 인라인 타입·유틸리티 중첩·무명 유니온이 커져 의미를 못 읽음(필드 3개 초과·3단 이상·5개 초과가 신호), 같은 인라인 타입 2곳+ 복제는 수치와 무관하게 지적 (02-3) / API가 `null`을 줄 수 있는데 Props non-optional, 수동 캐스팅으로 불일치 숨김, 실제 필수 필드에 `?` 남용, snake_case↔camelCase 변환 누락 (02-4) / `User | null`을 null 체크 없이 접근, discriminated union 분기 누락, `?.`가 아니라 명시적 분기가 필요한 자리 (02-5) / 판별자 필드 혼용(`kind` vs `type`), exhaustive check·helper 없는 switch (02-6) / type parameter가 한 번만 등장해 관계를 보존하지 않음, 본문이 쓰는 capability가 제약에 없어 단언으로 우회, 3개+ 제네릭이 단일 문자 (02-7) / 런타임 스키마가 있는데 사용처가 원본 값을 씀, generated 타입과 런타임 스키마의 정렬 근거 없음 (02-9) / `a!.b!.c!` 연쇄, `obj?.x!`처럼 optional chaining에 단언을 덧붙여 의도가 모순 (02-10) / `strictNullChecks`가 꺼져 있는데 컴파일러가 null을 잡는다고 전제, `noUncheckedIndexedAccess`가 켜져 있는데 인덱스 접근 결과를 바로 사용, `useUnknownInCatchVariables`가 꺼져 `any`인 `e`의 `e.message` 사용, `exactOptionalPropertyTypes`가 켜져 있는데 optional에 명시적 `undefined`, strict 계열을 끄거나 `skipLibCheck`·`ignoreDeprecations`를 새로 켜는 tsconfig 변경에 이유·되돌릴 시점 없음 (02-11) / 타입만 쓰는 import에 `import type` 미사용(런타임 import가 남음), `verbatimModuleSyntax`에서 값·타입을 한 import에 섞음, barrel이 타입·값을 구분하지 않음 (02-12) / 콜백 파라미터를 좁게 선언해 호출부가 단언으로 우회, `strictFunctionTypes`에서 메서드 문법으로 반공변 검사를 피함(의도인지 확인), 핸들러 타입을 구체 엘리먼트로 좁혀 재사용마다 단언 (02-13) / callback ref의 cleanup 미반환·반환 타입 불일치, polymorphic `as`의 자체 prop이 DOM intrinsic prop을 가림, 위임 상황에서 `currentTarget` 대신 `target` 사용 (02-14)

🔵 — public 함수·훅 반환 타입 미명시, 배열 반환 훅에 `as const` 없음, 미사용 타입 정의 (02-8) / 반환 타입을 넓게 선언해 호출부가 다시 좁힘 (02-13)

**지적하지 않음** — 미타입 외부 경계 한 곳에 격리되어 검증된 타입으로 반환되는 `any`(사유 주석만 확인), 사유·제거 조건이 붙은 `@ts-expect-error`(검증 가능한 suppression — `@ts-ignore`와 같은 등급이 아니고 타입 음성 테스트·추적 중인 외부 타입 결함에서 정상 도구) (02-1) / 파일 내부 local 컴포넌트의 인라인 Props, `FC<Props>` vs 직접 선언(관례 이탈만 확인, 관례가 없으면 지적하지 않음), JSX 속성에 인라인으로 쓴 핸들러의 이벤트 타입 생략 (02-2) / 임계값을 넘었다는 사실만으로 복잡도 지적 (02-3) / 값을 통과시키기만 하는 제약 없는 `T` — 호출부에서 구체 타입으로 고정돼 입력→반환 관계를 보존하므로 `unknown`과 같지 않다 (02-7) / 특정 검증 라이브러리를 쓰지 않은 것 — type guard·스키마 parse·수동 검증 함수 모두 유효, 계약 자체의 호환성은 16-1이 맡는다 (02-9) / 테스트 코드·초기화 직후처럼 불변식이 명확한 자리의 `!` (02-10) / 프로젝트가 켠 설정으로 컴파일러가 이미 잡는 항목의 중복 나열 (02-11) / `import type`으로 FSD 레이어 경계를 우회한 것 — 경계 위반 자체는 01-1 (02-12) / children 타입 불일치는 02-2와 함께 본다 (02-14)

**지적 원칙**: 타입 우회는 존재가 아니라 번지는 범위로 판정 — 범위(한 줄인가 exported 타입인가)·소비 위치(검증 없이 앱 내부로 전파되는가)·사유·제거 조건을 본다 (02-1) / 단언은 02-1이 범위를, 02-10이 근거를 본다 (02-10) / 제네릭은 `extends` 제약 유무가 아니라 입력과 출력의 관계 보존으로 판정 (02-7) / 서버→클라이언트 직렬화 경계는 21과 함께 본다 (02-9) / 타입 정의만 바뀌고 런타임 파서·스키마가 그대로면 16과 함께 본다 (02-4)

## 03. React 규칙

**적용 조건**: 기본 대상은 React 18 이상. 버전 조건이 붙은 조항은 `package.json`의 React 버전으로 판단하고, 버전을 확인하지 못하면 적용하지 않는다. 범위 밖 — effect 클린업·의존성·비동기 상태·리렌더 최적화는 04, 컴포넌트 크기·JSX 가독성·조건부 렌더링 표현은 05·06, 가상화·번들·lazy·Suspense·Transition 배치는 14, 서버·클라이언트 경계·Server Function·직렬화는 21.

**영향 높음**: Hook 순서 붕괴·hydration mismatch·상태 소실·비결정적 렌더·외부 스토어 계약 위반처럼 실제 크래시·오동작·검증 실패를 바로 지목할 수 있을 때만. React다운 표현·경계 명확화·미래 동시성 렌더 대비·계약 모호(contract ambiguity)처럼 현재 변경에서 닫힌 범주를 아직 닫지 못하면 영향 낮음 — 유지보수성·표현 선호·"나중에 문제 될 수 있음"만으로는 높음이 아니다.

🔴 — hook이 모든 렌더에서 같은 순서·개수로 호출되지 않음: 조건문·반복문·`&&`/삼항 안, early return 이후, 이벤트 핸들러·콜백·`useMemo` 내부, `use` 접두어 없는 일반 함수, `try/catch` 안에서 호출, `rules-of-hooks`를 suppression으로 끔 (03-1) / 렌더 중 **다른 컴포넌트**의 state 갱신, 무조건 `setState`(무한 루프), props·외부 객체·모듈 스코프 변수 변이, DOM 직접 조작·로깅 이상의 I/O·구독 등록, `Math.random()`·`Date.now()`·`new Date()`·`crypto.randomUUID()`로 렌더 결과가 매번 달라짐 — 렌더 중 `ref.current` 쓰기는 🟡 (03-2) / 불안정한 key로 매 렌더 재마운트(입력값·포커스·로컬 state 소실): 렌더 중 생성한 값(`Math.random()`·`crypto.randomUUID()`·`Date.now()`)이나 매번 새로 만든 객체 참조를 key로 — 정렬·필터·삽입·삭제가 있는 리스트의 인덱스 key, 형제 사이 중복 key는 🟡 (03-3) / props가 계속 진실의 출처인데 복사본을 만듦: `useState(props.x)` + effect로 동기화, 서버 응답을 로컬 state에 복사해 캐시와 별도 관리, 계산 가능한 값을 state로 두고 effect에서 갱신 (03-4)

🔴 (SSR/SSG를 쓰는 프로젝트에만 적용 — RSC 포함, 순수 CSR(Vite SPA·CRA·Electron renderer)은 제외) — 서버에 없는 정보(`window`·`document`·`localStorage`·`navigator`·`matchMedia`)를 첫 렌더에서 읽어 분기, locale·timezone·화면 크기에 따라 첫 렌더 출력이 달라짐, `Math.random()`·`Date.now()`·`new Date()`가 첫 렌더 출력을 결정(03-2와 함께), `useId` 없이 만든 DOM id가 서버·클라이언트에서 다름 — `getServerSnapshot` 부재·클라이언트 초기 snapshot과 불일치(03-9와 함께), `suppressHydrationWarning`을 트리 상단·넓은 범위에 붙여 원인을 가림은 🟡 (03-8)

🟡 — 외부 시스템 동기화가 아닌 effect: 사용자 액션 결과(전송·토스트·라우팅) 처리 → 핸들러, state를 보고 state를 갱신하는 연쇄 effect → 렌더 중 파생·`useReducer`, 변환·정렬·필터링을 effect + state로 → 렌더 중 계산, 마운트 시 1회 데이터 로드 직접 구현 → 쿼리 라이브러리(04) (03-5) / 렌더에 반영돼야 할 값을 `useRef`에 담아 UI 미갱신, 렌더에 안 쓰는 값(타이머 ID·이전 값·인스턴스)을 `useState`로 둬 불필요한 리렌더, ref로 자식 내부 state를 직접 조작(10 Encapsulation과 함께), cleanup에서 ref를 비우지 않아 언마운트 후 stale DOM 노드를 잡음 (03-6) / 모듈 스코프 mutable 변수로 렌더 간 상태 공유(인스턴스별 격리 안 됨), StrictMode effect 이중 실행에서 구독·타이머·연결 중복 등록 (03-7) / 외부 스토어를 `useEffect` + `useState`로 직접 구독(tearing, `useSyncExternalStore` 사용), `subscribe`가 렌더마다 새로 만들어져 매번 재구독, `subscribe`가 unsubscribe를 반환하지 않거나 등록 대상과 다른 것을 반환, SSR인데 `getServerSnapshot` 부재·불일치(03-8과 함께) — 데이터가 안 바뀌었는데 `getSnapshot`이 매번 새 객체·배열 반환(무한 렌더), mutable 스토어에서 스냅샷 즉석 생성은 🔴 (03-9)

🟡 (React 19+ 프로젝트에만 적용 — 19 미만이면 조항 전체 미적용, 없는 API를 쓰라는 요구 자체가 오탐) — `useActionState`/`useFormStatus`로 pending을 표현할 수 있는데 수동 `isLoading`을 병행해 두 출처가 어긋남, Action 에러 경로가 없어 실패가 조용히 사라짐(반환 state나 Error Boundary로 드러나야 함), `useFormStatus`를 form 바깥에서 호출, `useOptimistic` 낙관값이 실제 결과로 수렴하지 않거나 실패 시 되돌릴 경로 없음(17-4와 함께) — async Action 연속 실행 시 늦게 끝난 이전 Action이 최신 결과를 덮음은 🔴(17-2와 함께) (03-10)

**지적하지 않음** — 조건문·반복문 안의 `use(resource)` 호출(React 19+, Hooks 규칙 대상 아님), `exhaustive-deps` suppression은 04가 맡음 (03-1) / guarded render-phase adjustment — 이전 props와 비교해 **자기** state를 조정하고 종료 조건이 있으며 부수효과가 없으면 정당(지적 대상은 종료 조건 없음·다른 컴포넌트를 건드림·부수효과 섞임), `ref.current` 1회 lazy init, 순수한 렌더 중 파생 계산, "느릴 것 같아서" `useMemo`로 감쌀지는 10 Avoid Premature Optimization이 맡음 (03-2) / append-only이고 순서가 고정된 리스트의 인덱스 key, 상태를 일부러 리셋하려는 key 변경(`<Form key={userId} />`, 의도가 코드나 짧은 주석에 드러나는지만 확인) (03-3) / 초기값으로만 받고 이후 자식이 소유하는 uncontrolled 패턴(`initialX`/`defaultX`, 동기화 없음), 사용자가 편집 중인 draft처럼 의도적으로 props와 갈라지는 값 (03-4) / 외부 스토어 구독은 03-9, hydration 일치는 03-8이 맡음 (03-7) / 불일치가 불가피하고 그 노드에 국한된 `suppressHydrationWarning`(타임스탬프 등) (03-8) / 기존 `forwardRef` 코드가 남아 있다는 사실만(새 코드의 `forwardRef`만 프로젝트 관례 확인), React Compiler가 켜져 있을 때 수동 `useMemo`/`useCallback`/`memo` 추가 요구나 기존 수동 memoization 제거 요구(04-6·14-4와 같은 기준) (03-10)

**지적 원칙**: 판정은 "props를 초기값으로 썼는가"가 아니라 소유권 계약 — 자식 소유면 prop 이름이나 짧은 주석에 드러나야 하고, 이름이 `value`인데 동기화가 없으면 계약 모호이므로 영향·확신 축을 다시 판정해 보고 (03-4) / "첫 렌더에서 서버가 알 수 없는 값을 읽는가"로 판정 — 브라우저 전용 값은 첫 렌더를 서버와 같게 내고 effect에서 갱신해야 한다 (03-8) / lint가 잡는 항목이라도 suppression으로 꺼져 있으면 지적, diff에 없는 기존 코드는 지적하지 않음 (03 공통)

## 04. 상태 & 사이드이펙트

**적용 조건**: 범위 밖 — Hooks 호출 규칙·렌더 순수성·props→state 복사·effect가 아니어야 할 effect는 03, 가상화·번들·입력 반응성은 14, 상태를 어느 FSD 레이어가 소유할지는 01-7, props 전달 구조 자체는 `props.md`(`/code-review-props`).

**영향 높음**: 메모리 누수·런타임 에러·stale result 오염·경쟁 조건처럼 실제 실패가 닫힐 때만. 리렌더링·동기화 비용·패턴 불일치·최적화 여지에 머물면 영향 낮음.

🔴 — 구독·타이머·이벤트 리스너 등록 후 클린업 누락, 비동기 결과를 반영하는데 stale result가 최신을 덮는 것을 막는 장치가 **하나도** 없음, StrictMode mount → unmount → mount에서 구독·연결 중복 등록, cleanup이 등록한 것과 다른 대상을 해제(핸들러 참조 불일치) (04-1) / effect가 읽는 reactive value가 의존성에서 빠져 stale closure·재실행 누락, 빈 `[]`인데 변하는 props·state를 읽음, 의존성 배열이 없어 의도하지 않은 매 렌더 실행, 렌더마다 새로 생기는 참조(identity churn) 때문에 effect가 불필요하게 재실행(재구독·재요청·무한 루프) — `exhaustive-deps` suppression으로 의존성 검사 우회는 🟡 (04-2) / `isLoading`·`error`·`data` 중 UI에 반영되지 않는 상태, 빠른 연속 요청에서 이전 응답이 최신을 덮는 경쟁 조건, 미처리 Promise rejection, async 이벤트 핸들러 에러가 Error Boundary로 전파되지 않음 — 외부 부작용 반복 실행·순서 역전은 17을 함께 적용 (04-3) / 한 `useEffect`에 무관한 작업 여럿, 목적이 코드로 드러나지 않는데 설명·구조 분리도 없음 (04-4)

🟡 — 같은 성격 상태를 다른 방식으로 관리(Zustand와 useState+Context 혼용), 서버 상태(React Query)와 클라이언트 상태(Zustand) 경계 불명확, 같은 데이터를 서버 캐시와 로컬 state가 각자 들고 있음 (04-5) / `React.memo` 자식에 매 렌더 새 참조 props, Context Provider value가 매 렌더 새 객체이고 **그 때문에 실제로 비싼 리렌더**가 생김, 한 Context에 값·액션·UI 상태가 섞여 일부만 바뀌어도 전체 구독자 리렌더(분할·selector 검토), 파생 가능한 값을 별도 state로 (04-6) / 비동기 콜백·타이머가 캡처한 state가 최신이 아님(functional update 미사용), `state.items.push()` 같은 직접 변이 (04-7) / 연관 state를 개별 `useState`로 나눠 동기화 버그 가능(객체·`useReducer`로), 이름으로 용도를 알 수 없는 state, 파생 가능한 값을 별도 state로 (04-8)

🔵 — 페칭 라이브러리 사용 일관성, 캐싱 전략(`staleTime`·`gcTime`), 같은 데이터 중복 요청, optimistic update 적절성 (04-9)

**지적하지 않음** — stale result 방어를 `AbortController`로만 인정하기(cleanup `ignore` 플래그·request token/sequence 비교·쿼리 라이브러리 위임도 인정, 라이브러리가 처리하면 중복 구현 요구 안 함), 취소가 필요 없는 effect(구독·타이머·리스너)에 `AbortController` 요구, 취소하면 안 되는 요청(전송 완료가 목적인 mutation)에 abort 요구 (04-1) / 객체·배열·함수를 의존성에 넣었다는 사실만(부모가 안정적으로 유지하는 객체·모듈 스코프 상수·`useMemo`/`useCallback`으로 고정된 값·쿼리 라이브러리 캐시 객체는 그대로 넣어도 됨), suppression을 그 자체만으로 자동 허용·자동 금지 (04-2) / 의존성 5개 이상이라는 사실만 — 분리 검토 신호일 뿐 자동 위반 아님 (04-4) / prop drilling 구조·전달 단계 수는 `props.md`가 전담 — 여기서는 상태를 어디에 두었는가가 문제일 때만 (04-5) / Context value에 `useMemo` 무조건 요구 — 소비자 영향(Provider 리렌더 때 자식 트리도 어차피 리렌더되면 막는 것이 없음, 자식이 `memo`로 차단됐거나 구독자가 많을 때만 효과)·identity contract(value 참조가 effect 의존성·`memo` 비교에 쓰여 churn이 실제 문제를 만드는가)·갱신 빈도(거의 안 바뀌는 Provider는 대상 아님)를 확인해 근거가 있을 때만, React Compiler가 켜진 프로젝트는 요구하지 않음 (04-6) / optimistic update 실패 시 rollback 경로는 17-4가 맡음 (04-9)

**지적 원칙**: identity churn은 참조가 렌더마다 새로 생성되고(본문 리터럴·매번 새 객체 반환) 그 결과 effect가 불필요하게 재실행되는 것이 **함께** 성립할 때만, suppression은 짧은 근거·effect 분리나 stable callback/ref 같은 구조적 대안·stale closure·숨은 의존성·재실행 누락 위험을 함께 본다 (04-2)

## 05. 함수 & 컴포넌트 구조

**영향 높음**: 구조 혼재가 실제 검증 실패·오동작·반복 회귀 경로를 만들어 현재 변경에서 닫힐 때만. 읽기 비용·분리 필요·단순화 여지에 머물면 영향 낮음.

🔴 — 함수 20줄 초과는 분할 검토 신호 — 줄 수보다 추상화 수준 혼재·중첩 3단+·독립 작업 3개+로 읽기 비용이 실제로 커지는지 (05-1) / 컴포넌트 150줄 초과 + 관심사 혼재(JSX 인라인 로직 10줄+, `useState` 5개+, return 이전 로직이 파일 절반+, 독립 UI 영역 3개+, 렌더링·비즈니스 로직이 한 함수), 300줄+에 신호까지 겹치면 분할을 강하게 요구 (05-2) / 한 파일에 export 컴포넌트 2개+ (05-8)

🟡 — if-else 중첩 2단+ → early return, 단 컴포넌트는 모든 hook 호출이 그 앞에(03-1) (05-3) / 매개변수 3개 초과, 의미 불분명한 boolean 매개변수 → 객체 (05-4) / 고수준 호출과 저수준 구현 혼재 (05-5) / 컴포넌트가 페칭·로직·렌더링 모두 담당, 훅이 무관한 상태 여럿 관리, 훅 반환값 10개+, 역할을 알 수 없는 훅 이름(`useData`) (05-6) / 2+ 컴포넌트·훅·슬라이스에 같은 로직·API 호출·변환·검증 패턴 복사, 기존·새 구현이 모두 쓰이면서 같은 동작·정책을 중복 구현(A·A′의 공존·동등성·통합 가능성은 이 조항 담당) — 같은 수정을 여러 복사본에 반영해야 하는 구조, 이름만 다른 같은 로직, 이전 구현 옆에 새 구현을 더한 중복 경로면 강하게 (05-7) / 핸들러 5줄 초과, 인라인 핸들러에 로직, 핸들러가 뭉쳐 controller 역할 (05-9)

**지적하지 않음** — JSX 표현·조건부·리스트 렌더링은 06, 발견성·파일 위치는 13, 매직값·상수 위치는 08, barrel·path alias·import는 09 (05 공통) / 150줄 초과를 줄 수만으로 자동 위반 처리 (05-2) / 좌표·범위처럼 함께 읽히는 값 묶음(예외 가능), props 개수·전달 구조는 `props.md`가 더 구체적으로 다룸 (05-4) / export하지 않는 내부 헬퍼 컴포넌트 (05-8) / 핸들러 네이밍은 07 (05-9) / 전환 뒤 쓰이지 않는 이전 구현은 09-4, 이름·문자열·토큰이 비슷하다는 것만으로 같은 동작이라 하기, 정책이 다르거나 추상화 비용이 더 클 때 통합 강제 (05-7)

**지적 원칙**: 줄 수가 아니라 한 단위에 섞인 책임을 근거로 댄다 (05-1·05-2·05-5) / diff 밖 기존 구현(A)과는 모양이 아니라 동작을 비교 — 입력 계약·결과, 빈 값·오류·취소 경계, 부수효과, 그 자리에서 쓸 수 있는지(export·의존 방향·실행 환경), 정책 차이·마이그레이션처럼 일부러 나눈 이유. 바로 가져다 쓰라는 권고와 공통 위치로 옮기는 설계를 구분하고, 지적 위치는 A′·A는 근거로 인용(00-3). 단일 출처로 남길 구현과 지울 복사본을 제안하고, 공통화보다 삭제·통합이 단순하면 그쪽 우선 (05-7)

## 06. JSX

**영향 높음**: 의도하지 않은 렌더 결과가 실제로 화면에 나오거나 동작을 바꿀 때만. 가독성·분기 복잡도·표현 단순화에 머물면 영향 낮음.

🔴 — `&&` 좌변이 `0`·`''`·`NaN`이면 그 값이 그대로 렌더됨(숫자 state·배열 `length`·문자열을 좌변에) → 명시적 boolean (06-1)

🟡 — 삼항 2단+ 중첩·3개+ 분기 삼항 체인, 조건부 블록 10줄+, 같은 조건이 JSX 곳곳에 흩어짐 (06-2) / `map` 콜백 10줄+·복잡한 조건부 중첩, `map` 안 hook 호출(03-1 위반), 항목마다 새 인라인 객체·핸들러를 memo 자식에 전달 (06-3) / Props 4개+ 한 줄, 인라인 함수 5줄+, 인라인 `style` 3속성+(11), 자식 1개 Fragment·불필요한 wrapper `div`, 의미 없는 JSX 중첩 5단+ (06-4) / 커스텀 컴포넌트에 무분별한 `{...props}`(rest props는 HTML 요소에만) — 전달 props 추론 불가, DOM에 알 수 없는 속성 경고, 재지정 순서 의존 (06-5)

🔵 — 컴포넌트를 반환하는 함수를 본문 안에 정의(매 렌더 새 타입 → 재마운트), render prop·children 혼용, 빈 Fragment와 `null` 반환 혼재 (06-6)

**지적하지 않음** — key 안정성·렌더 순수성은 03, 컴포넌트 크기·핸들러 추출은 05, className·디자인 토큰은 11, 접근성은 12 (06 공통) / key 선택은 03-3 — 리스트는 key가 아니라 표현 복잡도와 호출 위치를 본다 (06-3)

## 07. 네이밍 & 주석

**영향 높음**: 이름 혼란이 실제 잘못된 사용·잘못된 분기·검증 실패로 이어질 때만. 가독성·컨벤션·설명 명확성에 머물면 영향 낮음.

🔴 — 약어·한 글자(`d`, `temp`, `val`)·모호한 이름(`data`, `info`, `item`), 조건·구현 세부를 과하게 합친 긴 이름(줄이기보다 책임 분리·중간 개념 추출), 동사 없는 함수명, `is/has/should/can` 없는 boolean (07-1) / 핸들러 `handle`·콜백 props `on` 접두어 없음, 의도 대신 구현을 드러낸 콜백 이름(`onSetIsOpenTrue`) (07-2) / 같은 데이터를 파일마다 다른 이름으로(`user`/`userData`/`currentUser`) — 표준 이름 제안 (07-7)

🟡 — 내용을 설명 못 하는 컴포넌트명, `Container`·`Wrapper` 단독, 파일명 불일치, `Manager`·`Processor` 접미어 (07-3) / `use` 없는 커스텀 훅(03-1 검사도 누락), hook을 부르지 않는 `use` 함수, 반환 성격이 안 드러나는 훅 이름 (07-4) / `I` 접두어 불일치(합의 없으면 no `I`), `{ComponentName}Props` 미준수, 유니온 멤버 대소문자 불일치 (07-5) / 파일 케이스 규칙 이탈(컴포넌트 PascalCase·훅 camelCase+use·유틸 camelCase), PascalCase·kebab-case 혼재 (07-6) / 코드를 반복하는 주석, 주석 처리된 코드, 코드와 어긋난 주석, 미연결 TODO·FIXME (07-8) / 비자명한 비즈니스 규칙·복잡한 정규식·workaround(이유+제거 시점)·의도적 비표준 패턴·의도적 React 기본 동작 이탈(리셋용 `key`, `exhaustive-deps` suppression)에 주석 없음 (07-9)

**지적하지 않음** — 상수 추출·위치는 08 (07 공통) / 루프 `i`, `Result<T, E>` 문맥의 `result`, 구체적이라 긴 이름 자체, `disabled`·`checked`·`selected`·`required`·`readOnly`·`open`처럼 플랫폼·HTML 표준 속성과 맞춘 boolean (07-1)

**지적 원칙**: 취향이 아니라 호출부·후속 변경에서 무엇을 오해하게 만드는지를 근거로 댄다 (07-1~07-7)

## 08. 상수 & 매직값

**영향 높음**: 이번 변경에서 값이 실제로 어긋나 현재 호출 경로의 오동작·검증 실패·외부 계약 파손을 지목할 수 있을 때만. 의미 불명확·i18n·타입 안전성·표현 정리에 머물면 영향 낮음.

🔴 — 의미 불분명 숫자 리터럴, 타임아웃·재시도 횟수·페이지 크기·z-index·breakpoint 인라인 하드코딩 → named constant (08-1)

🟡 — API 엔드포인트·라우트·localStorage 키 문자열 산재, 상태값 문자열 비교 → 유니온·상수 객체, 사용자 노출 문구 하드코딩 → 단순 상수보다 i18n 권장 (08-2) / 같은 값의 상수가 2개+ 파일에 각각 선언(Query Key·endpoint·localStorage 키·유효성 상수·설정값·z-index) → 단일 출처 (08-3) / 프로젝트가 정한 상수 위치 규칙 이탈, 같은 성격 상수가 여러 위치에 흩어짐 (08-4)

🔵 — 함께 바뀌어야 할 상수가 흩어짐(`as const` 객체로 묶기), 상태 유니온을 문자열 리터럴로만 관리, 단위 없는 이름(`TIMEOUT` → `TIMEOUT_MS`) (08-5)

**지적하지 않음** — 로그 전용·개발자 전용 에러·테스트 내부 문자열, protocol·key·route·enum 같은 번역 대상이 아닌 식별자 문자열 (08-2) / 지금 서로 같은 값의 반복을 "나중에 한쪽만 바꾸면 깨진다"는 가정으로 영향 높음으로 올리기 — 이번 변경으로 이미 어긋난 값과 그 값을 소비해 실패하는 현재 경로가 있어야 높음이고, 중복 선언 발견만으로 빌드·타입체크 실패를 입증한 것이 아니다 (08-3) / 리뷰어가 새로 정한 위치 규칙 — 프로젝트가 이미 쓰는 위치가 기준이고, FSD 프로젝트는 01의 레이어·segment 규칙이 우선한다 (08-4)

**지적 원칙**: 상수 중복은 변경 파일에 새로 선언된 값이 같은 diff의 다른 파일이나 인접 모듈에 이미 있는지만 본다. 저장소 전체 스캔으로 넓히지 않는다 (08-3)

## 09. Import & Dead Code & 일관성

**영향 높음**: dead code·suppression 우회·패턴 불일치가 실제 버그나 검증 실패로 닫힐 때만. 컨벤션·가독성·스타일 개선에 머물면 영향 낮음.

🔴 — 도달 불가 코드, 미사용 변수·함수·타입·import, 주석 처리된 코드 블록, 장기 비활성 feature flag, 새 구현으로 전환한 뒤 이전 구현의 호출·등록·외부 공개 계약이 남지 않았음을 확인했는데도 남은 이전 구현 (09-4) / `react-refresh/only-export-components` 등 suppression으로 Fast Refresh 우회 — 비컴포넌트 값을 같이 export하려고 lint를 끔 → 파일 분리·export 정리, 이유 없는 suppression은 리뷰 우회 (09-6) / 같은 성격 컴포넌트의 구조 상이, 같은 성격 API 호출 방식 상이(`useQuery`·`fetch` 혼용), 파일마다 다른 에러 처리 방식 (09-8)

🟡 — 미사용 import, 같은 모듈 여러 줄 import, `import type` 미사용 (09-1) / named·default export 혼용, re-export로 내부 구현 노출, 한 파일 5개+ export (09-2) / 로직 없는 wrapper, 값을 그대로 반환하는 함수, 빈 `useEffect`·`catch` (09-5) / 컴포넌트 선언 방식·세미콜론·따옴표·들여쓰기 불일치 (09-7) / 에러 표시 표면(toast·인라인·Error Boundary)·메시지 포맷·사용자용/개발자용 구분의 불통일 (09-9) / 이중 부정, 부정형 변수명(`notReady`), `if (!cond)` 블록이 `else`보다 김 (09-10) / 5단+·원본 구조를 가리는 destructuring, 과도한 rename (09-11) / `!!value`, falsy 값이 달라지는 위험한 truthy check (09-12) / 3개+ 조건의 `&&`·`||` 연결, 괄호 없는 연산자 혼합 (09-13)

🔵 — barrel export·path alias 불일치, 상대·절대 경로 혼용(슬라이스 간 절대, 내부 상대) (09-3)

**지적하지 않음** — 레이어 방향·Public API 경계는 01, 이름 적절성은 07, 테스트·목 전용 파일은 리뷰 제외 (09 공통) / 자동화 도구가 정리할 단순 순서 문제만 보이면 우선순위 낮음 — 실제 혼란·오독·unused가 diff에 드러날 때 우선 (09-1) / FSD에서 barrel이 Public API 경계면 01 우선 (09-3) / 이유와 제거 조건이 있는 짧은 실험·A-B 테스트·임시 비활성화 주석 코드, 두 구현이 모두 쓰이는 중복은 05-7 — 공존만으로 이 조항을 적용하지 않음 (09-4) / 라이브러리 제약·마이그레이션 임시 조치처럼 이유와 제거 조건이 diff 안에 명확한 suppression (09-6) / 실패가 삼켜지거나 잘못 전파되는지는 `exception.md` 우선 — 여기선 표현 통일만 (09-9) / 순수 스타일 차이뿐인 `if (array.length)` — falsy 의미 혼동이나 숫자 의미를 분명히 해야 할 때만, JSX `&&` falsy 렌더링은 06-1 우선 (09-12)

**지적 원칙**: 미사용은 호출자가 검색되지 않았다는 것 하나로 확정하지 않는다 — 등록 경로·동적 호출·외부 공개 계약을 확인하고, 그 범위가 닫히지 않으면 `확인 필요` (09-4) / formatter가 고칠 문제보다 실제 의미 혼란·잘못된 사용 경로를 만드는 문제를 우선 (09-1·09-7·09-8)

## 10. 개발 원칙

**영향 높음**: 원칙 위반이 사용자 오동작·데이터 손상·보안 노출·검증 실패·외부 계약 파손 중 하나를 낳는다고 현재 변경에서 닫아 말할 수 있을 때만. 구조 혼재·중복·과복잡·유지보수성 저하·원칙 불일치처럼 설계 비용은 커도 닫힌 높은 영향 범주를 증명하지 못하면 영향 낮음. 원본은 SSOT·SRP·SoC·FailFast·Immutability를 "높은 영향도로 이어질 수 있는 예시", DRY~CoC를 "주로 낮은 영향도", DIP~Parsimony를 "영향 낮음 참고"로 묶지만 보정 예시일 뿐 등급이 아니다.

등급 표기 없음 — 같은 데이터가 여러 state에 중복, 서버값을 로컬 state에 복사, 상수·타입 정의 중복 (10-SSOT) / 컴포넌트가 페칭·로직·렌더링 전부 담당, 훅이 무관한 상태 여럿 관리 (10-SRP) / UI·비즈니스 로직 혼재, 라우팅이 도메인 컴포넌트에 (10-SoC) / 빈 catch, 잘못된 입력이 깊이 전파된 뒤 에러, API 응답 미검증 (10-FailFast) / `push()`·`splice()`·`Object.assign(target)` 등 상태 직접 변이 (10-Immutability) / 로직·유효성 규칙·API 패턴 복사 (10-DRY) / 불필요한 추상화, 3줄 로직을 별도 유틸·훅·HOC로 (10-KISS) / 미사용 Props·타입, "나중에 쓸" 유틸, 사용처 하나인 과한 일반화 (10-YAGNI) / variant 추가마다 기존 컴포넌트 수정, 길어지는 if/else 렌더 → 맵·레지스트리 (10-OCP) / 거대한 객체 Props 중 1-2개 필드만 사용, 과다한 훅 반환값 (10-ISP) / 3단+ 체이닝(`user.address.city.name`), 내부 구조 강결합 (10-LoD) / `getX`가 데이터 변경, `isValid`가 예외 던짐, 이름·동작 불일치 (10-PoLA) / 반환하면서 상태 변경, getter 부수효과 (10-CQS) / HOC 3단+ 중첩, 상속 기반 확장 (10-Composition) / 내부 state를 ref로 노출, 내부 헬퍼가 Public API에 (10-Encapsulation) / API 응답·localStorage·URL 파라미터 미검증 (10-Defensive) / API 형식(snake_case, ISO 날짜)이 UI까지 관통, 변환 로직 인라인 (10-DataPresentation) / 필요 이상 데이터를 Props로, 환경변수 불필요한 클라이언트 노출 (10-LeastPrivilege) / 단일 컴포넌트 전용 타입·유틸이 먼 shared에 (10-Colocation) / 암묵적 default export, `==`, 암묵적 타입 변환 (10-Explicit) / 모듈마다 다른 파일·export·훅 네이밍 패턴 (10-CoC) / API 클라이언트 구현체 직접 import (10-DIP) / 더블 클릭 중복 요청, StrictMode effect 부수효과 중복 (10-Idempotency) / 주석 없는 복잡한 정규식, 이유 없는 workaround, 암묵적 의존성 (10-Transparency) / 입력 관대·내부 엄격 미적용 (10-Robustness) / 밖에서 상태를 조회해 판단 → 객체·훅에 행동 지시 (10-TellDontAsk) / `user.fullName`과 `getFullName(user)` 혼재 (10-UniformAccess) / 성능 문제 없는 `useMemo`·`useCallback` 남용, 프로파일링 없는 최적화 — React Compiler 프로젝트의 수동 메모이제이션 추가는 특히 근거 요구 (10-NoPrematureOpt) / useState로 충분한데 전역 상태 라이브러리, 불필요한 추상화 레이어 (10-Parsimony)

**지적하지 않음** — 구체 모듈이 이미 잡은 지적을 원칙 이름만 바꿔 반복, 위험을 말하지 않고 원칙 이름만 붙인 지적, 원칙 이름이나 개별 증상보다 상위라는 이유만으로 등급 복사·상향 (10 공통) / props·서버값을 state에 복사하는 구체 패턴은 03-4 우선 (10-SSOT) / 크기·분할 판단은 05 우선 (10-SRP) / 실패 흐름 자체는 `exception.md` 우선 (10-FailFast) / `!!value` 같은 구체 표현은 09-12 우선 (10-Explicit) / 외부 부작용이 실제로 두 번 적용되면 17로 올린다 (10-Idempotency)

**지적 원칙**: 서로 다른 모듈의 지적 둘 이상이 한 원칙 위반의 증상이면 그 원칙을 근본 원인으로 제시하고 파생된 지적을 나열, 흩어진 증상이 공통 원인일 수 있으면 그 연결을 설명, 어느 모듈 축에도 걸리지 않는 위반도 대상 — 원칙 이름 대신 현재 변경의 trade-off와 근본 원인을 적는다 (10 공통)

## 11. 스타일링 *(Tailwind 프로젝트 전용)*

**적용 조건**: Tailwind + 시맨틱 디자인 토큰 시스템 전제 — CSS Modules·CSS-in-JS·vanilla-extract 등 다른 스타일링 체계에는 적용하지 않는다. 색상 대비·motion 같은 접근성 영향은 12가 우선.

**영향 높음**: 디자인 시스템 위반이 실제 접근성 실패·브랜드 의미 파손·전역 회귀로 닫힐 때만. 재사용성·일관성·className 정리에 머물면 영향 낮음.

🔴 — 정적 값에 `style={{}}`(정적 레이아웃·상태 표현·hover/focus·유한 분기는 Tailwind `className`) (11-1) / 토큰에 있는 값을 hex로 하드코딩, Tailwind 기본 팔레트(`gray-800`, `text-blue-500`), 반복되는 arbitrary color/value를 토큰 후보로 남기지 않음 (11-4)

🟡 — `isActive ? A : B` 같은 유한 조건을 inline style로 → 조건부 className (11-2) / 단순 레이아웃·spacing·border·flex·grid 때문에 새 `.css` 파일 (11-3) / `!important`, `@apply` 남용, 컴포넌트 전용 CSS를 전역 스타일에 추가 (11-5)

🔵 — 과도하게 긴 className·반복되는 스타일 묶음·렌더 가독성을 해치는 조건식 정리, 문자열 연결로 만든 조건부 className이라 Tailwind가 정적 추출 못 함 (11-6) / 전역 스타일은 `app/styles/`, 컴포넌트 전용 CSS는 그 컴포넌트 폴더 (11-7)

**지적하지 않음** — JS 런타임 계산값(동적 위치·크기·transform)의 `style={{}}` (11-2) / Tailwind로 표현하기 어려운 keyframe·복잡한 선택자(`:not`, 구조 의존)·gradient·clip-path·mask·써드파티 컴포넌트 오버라이드용 CSS 파일 (11-3) / 색상 대비 판단 자체 — 접근성 영향이 보이면 그 사실만 적고 판단은 12에 둔다 (11-4)

## 12. 접근성

**적용 조건**: 변경 라인에 interactive UI(클릭·선택·제출·열기·닫기·이동) 생성·변경, `onClick`·`onMouse*`·`onPointer*`·keyboard handler·`tabIndex`·`role`·`aria-*` 변경, modal·dialog·popover·dropdown·tooltip·flyout·drawer·route transition UI, input·select·textarea·checkbox·radio·validation message·error summary, icon-only button·image·SVG·canvas·chart·visual status indicator, animation·transition·reduced-motion·contrast 관련 class·token이 보일 때만 적용한다. backend-only diff, 데이터 모델만 바뀐 diff, UI에 닿지 않는 설정 변경에는 적용하지 않는다. 이번 diff가 직접 악화시키지 않은 기존 접근성 문제와 접근성 영향이 없는 JSX 가독성·조건부 렌더링(06)은 지적하지 않는다.

**영향 높음**: 키보드 경로 차단·accessible name/label 부재·focus 관리 실패·form error 미연결처럼 사용자가 기능을 조작하지 못하게 될 때만. 대안이 남아 있고 보조기술 힌트·상태 동기화·motion/contrast 명확성이 부족한 정도면 영향 낮음 — 접근성 문제라는 것만으로 높음이 아니고, maintenance·style만의 문제는 높음 근거가 아니다.

🔴 — 클릭 가능한 `div`/`span`으로 button/link를 흉내 내 키보드 경로까지 막힘, button↔link 의미 뒤바뀜 — `role="button"`/`"link"`는 native를 쓸 수 없는 명확한 제약이 있을 때만 (12-1) / keyboard activation 없는 `onClick` custom control, hover·drag로만 열고 닫는 필수 UI, `tabIndex={-1}`·focus 제거로 조작 대상이 탐색에서 빠짐, custom option·tab·menu item의 Enter/Space/Arrow 미처리 (12-2) / modal·dialog·popover·flyout·drawer·route transition·stepper·wizard에서 필요한 focus 진입·복원·trap(modal/dialog) 누락, 조건부 렌더로 focus가 `<body>`로 떨어짐 (12-3) / icon-only button·form control·dialog·landmark·region에 accessible name 없음, placeholder만 label로 사용, 수동 `id`가 인스턴스마다 중복(→ `useId`) (12-4) / form 입력의 validation 오류·제출 실패를 **화면에 표시하는** UI를 추가·변경하면서 그 오류가 control과 연결되지 않거나(`aria-describedby`·`aria-errormessage`) 보조기술에 전달되지 않음(error summary·toast·inline error가 live region·focus 이동 없이 조용히 추가), `aria-invalid`가 실제 validation 상태와 불일치 (12-5) / 의미 있는 `<img>`·icon·SVG·canvas·chart에 텍스트 대안 없음, 색·위치·굵기만으로 success/error/selected 전달 (12-6) / 부정확한 `role`·`aria-*`로 native 대체, role에 허용되지 않는 속성, `aria-expanded`·`aria-selected`·`aria-checked`·`aria-current`·`aria-hidden`이 실제 UI 상태와 다름, `aria-hidden="true"` 안의 focusable 요소, 존재하지 않는 id 참조 — native 구조를 덮는 패치면 12-1과 함께 semantic element 우선 (12-7)

🟡 — native 대체가 가능하지만 일부 보완이 있는 흉내 요소 (12-1) / diff에서 직접 추론될 때만: reduced-motion 대안 없는 animation·parallax·반복 flashing, 색·token 변경으로 contrast 저하가 명확, 정보가 색 대비·motion으로만 전달 (12-8)

**지적하지 않음** — 기본 keyboard 동작이 있는 native `<button>`·`<a>`·`<input>`에 별도 handler 요구 (12-2) / focus 이동이 오히려 해로운 가벼운 tooltip (12-3) / visible text가 이미 이름인 native control에 중복 `aria-label` 요구 (12-4) / 모든 form에 live region 강제 — 변경 코드가 오류를 동적으로 표시할 때만 (12-5) / **오류를 화면에 아예 표시하지 않는 것** — 조회·저장 실패를 삼키거나 `error`·`isPending`을 읽지 않아 빈 화면·이전 결과가 남는 것은 공지가 아니라 상태·예외 처리 문제(04·예외 패스)다, 보이지 않는 오류를 "보조기술에 전달되지 않는다"로 적지 않는다 (12-5) / **form과 무관한 상태 변화**(연결 상태·진행률·로딩 표시)에 live region이 없는 것 — 색·아이콘으로만 전달되면 12-6 (12-5) / 장식임이 코드에서 명확한(`alt=""`·`aria-hidden="true"`·CSS background) 장식 이미지 (12-6) / 주관적 화면 판독·캡처 기반 추정만의 motion/contrast (12-8) / 11이 맡는 Tailwind·디자인 토큰·className·팔레트 취향 — contrast는 접근성 영향이 직접 보일 때만 여기서 (12-8)

## 13. DX

**적용 조건**: DX 고유 영역(발견성·수정 안전성·진입점 명확성·온보딩 비용)이 남을 때만 본다. FSD 역할 배치(01)·네이밍(07)·상태 관리(04)·성능(14)처럼 다른 모듈이 더 직접 다루는 영역은 그쪽이 우선.

**영향 높음**: 발견성·수정 안전성 저하가 실제 잘못된 사용·회귀·검증 실패로 닫힐 때만. 온보딩·탐색 비용·패턴 발견성에 머물면 영향 낮음.

🔴 — 이름만으로 역할을 알 수 없는 파일·폴더, 열어도 사용법이 바로 안 보이는 public API, 비슷한 책임 코드가 흩어져 첫 진입점이 모호 (13-1) / 한 곳 수정에 여러 파일을 암묵적으로 알아야 함, side effect·상태 변경·외부 호출 경계가 숨음, 같은 개념이 여러 이름·형태로 노출돼 잘못된 사용 유도 (13-2)

🟡 — 같은 기능군의 생성·조회·변경 방식이나 훅·selector·query key·IPC API 호출 패턴이 제각각 (13-3) / 비자명한 초기화 순서·workaround·잘못 쓰기 쉬운 public API에 짧은 주석·usage 예시 없음 (13-4) / 새 코드 추가 위치가 구조로 안 보임, 비슷한 파일의 segment 구조 상이, 상수·타입·helper 단일 출처 없음 (13-5) / 첫 탐색 경로에서 안 보이는 위치, 깊은 로컬 폴더에 숨은 재사용 코드, shared/common에 올라간 전용 코드, 같은 성격 파일의 위치 규칙 상이 (13-6)

🔵 — 공용 진입점의 이름·위치·API 설계 때문에 재사용 경로를 찾거나 쓰기 어려움, 너무 이른 추상화로 API가 불필요하게 복잡 (13-7)

**지적하지 않음** — 코드만 읽어도 명확한 내용의 장황한 설명 (13-4) / 동일 구현의 반복과 A·A′ 공존 — `05-7`이 담당하므로 13-7로 다시 지적하지 않는다 (13-7) / props 개수·같은 도메인 값의 낱개 전달·객체로 묶기 주장 — `P-3`의 책임이라 13-7로 다시 지적하지 않고, Props 패스가 꺼져 있어도 이 조항으로 대신 보고하지 않는다. 별도의 진입점 탐색 문제라면 무엇을 찾을 수 없는지 독립된 근거를 댄다 (13-7)

**지적 원칙**: "어렵다"가 아니라 다음 개발자가 어디서 막히는지(어느 파일·public API에서 무엇을 바로 알 수 없는지) 적는다 (13-8)

## 14. React 성능

**적용 조건**: 변경 라인에 리스트/테이블/그리드 렌더·페이지네이션·무한 스크롤, 라우트 추가·대형 컴포넌트·라이브러리 import, 검색/필터/입력에 연결된 무거운 계산·렌더, 이미지·아이콘 세트·폰트·차트·3D 씬 추가, 새 전역 상태 구독·Context Provider 추가가 보일 때만 적용한다. **데이터 규모가 작고 정적인 UI 변경에는 적용하지 않는다.** 렌더 횟수가 아니라 렌더·로드 비용과 반응성이 대상이다 — 불필요한 리렌더·Context value 참조·memo 대상은 04, key 불안정 재마운트는 03, 순수 자료구조·알고리즘 복잡도는 15, 함수 길이·컴포넌트 분할은 05. diff에 없는 기존 코드는 지적하지 않는다.

**영향 높음**: 실제 데이터 규모에서 프레임 드랍·입력 지연·초기 로드 급증이 명확히 닫히고, 어떤 조작에서 무엇이 지연되는지 지목할 수 있을 때만. 규모가 커지면 문제 될 구조·표준 대안 부재·측정 보강 필요에 머물면 영향 낮음. 추정만으로 🔴을 주지 않는다.

🔴 — 상한이 열렸거나 서버 페이지네이션이 없는 목록을 가상화 없이 전량 렌더, 무한 스크롤의 이전 페이지 노드 누적, 무거운 행(차트·이미지·에디터)을 화면 밖까지 렌더 (14-1) / controlled input의 값 state를 transition 안에서 갱신해 입력이 씹히고 커서가 튐 — 입력값은 긴급 업데이트, 무거운 소비만 지연 (14-3) / 갱신으로 이미 보이던 콘텐츠가 fallback으로 되돌아감 — 갱신을 transition으로 감싸 기존 화면 유지 (14-6)

🟡 — 새 라우트가 초기 번들에 포함, 진입 직후 필요 없는 모달·에디터·차트·3D 뷰어나 무거운 라이브러리를 정적·최상위 import, barrel 통째 import로 tree-shaking 깨짐, `lazy`에 `Suspense` 경계·로딩 fallback 없음(18이 아니라 여기서 지적) (14-2) / 입력마다 대형 리스트 즉시 필터·재정렬, 입력 state가 무거운 형제 트리까지 리렌더, debounce/throttle 없이 keystroke마다 요청, transition/deferred로 미뤘는데 `isPending` 등 진행 표시 없음, `await` 뒤 상태 갱신을 transition으로 감싸지 않음 (14-3) / 매 렌더 대형 정렬·그룹핑·정규식 컴파일·JSON 파싱·새 `Intl.NumberFormat`/`Intl.DateTimeFormat`, 항목마다 같은 파생값 재계산 (14-4) / 원본 크기 이미지를 CSS로 축소, 목록 썸네일에 `loading="lazy"`·`decoding="async"` 없음, 크기·`aspect-ratio` 미지정 레이아웃 시프트, 아이콘 개별 이미지 요청 (14-5) / Suspense 경계가 너무 위(작은 로딩에 화면 전체가 사라짐)거나 없음(트리 전체가 멈춤), fallback 높이 불일치·라우트마다 전체 스켈레톤·잘게 쪼갠 형제 경계로 레이아웃이 흔들림, 경계 안쪽 Error Boundary가 없어 로딩 실패가 무한 fallback·트리 크래시 (14-6)

🔵 — hot path 최적화·메모리를 더 쓰는 선택·가독성을 크게 희생한 최적화에 근거(프로파일·데이터 규모)나 얻는 값이 없음 (14-7)

**도구 혼동**: 렌더 비용으로 입력이 끊김 → `useTransition`/`useDeferredValue`, 요청이 너무 잦음 → debounce/throttle, 이전 결과가 최신을 덮음 → abort·stale-result 무시(04-1) — 뒤바꾼 코드도 지적한다. `useDeferredValue`는 요청을 줄이지도 취소하지도 않으므로 호출 자체를 줄여야 할 자리의 deferred는 문제가 남은 것으로 본다 (14-3)

**지적하지 않음** — 상한이 수십 건으로 고정된 목록 (14-1) / 측정 없이 `useMemo`/`useCallback`을 더 붙이라는 요구 — 측정 없는 `useMemo` 남발은 10이 다룬다 (14-4)

**지적 원칙**: 실제 데이터 규모를 먼저 확인한다 (14-1) / 경계마다 "이 안이 로딩 중일 때 사용자가 무엇을 잃는가"를 묻는다 — 잃는 범위가 필요 이상 넓으면 경계를 아래로, 산발적으로 흔들리면 위로 (14-6)

## 15. 알고리즘 복잡도

**적용 조건**: 같은 일을 더 낮은 Big-O로 할 수 있는데 높은 복잡도로 짰는지만 본다 — 리렌더·memo·Context는 04, 가상화·번들·lazy·입력 반응성·이미지는 14, 함수 길이·중첩은 05, 에러 처리·패턴 일관성은 09. 파일 I/O·DB 항목은 Electron main·BFF 코드를 함께 다룰 때만 적용한다.

**영향 높음**: 현재 데이터 규모·호출 빈도에서 이미 검증 실패·사용자 오동작·처리 불가, 또는 제품 동작을 사실상 막는 성능 저하로 이어질 때만. "느릴 수 있다"·유지보수성·더 나은 자료구조가 있다는 데 머물면 영향 낮음 — 실제 규모·hot path·사용자 영향이 닫혀야 높음. 10건 배열의 O(N²)처럼 현재 규모에서 상관없으면 낮음.

🔴 — 중첩 루프 안 `.find`/`.includes`/`.some`(O(N·M)) → Map/Set, React 리스트 렌더 안이면 더 강하게 (15-1) / 같은 컬렉션 반복 선형 탐색 → Set·Map (15-2) / 루프·`reduce`의 누적 spread(O(N²)) → `.push()` (15-3) / 같은 입력의 pure 계산 반복 — memo 없는 재귀(DP 후보)·루프 불변값 재계산 (15-4) / N+1 I/O — 루프 안 1건씩 `await`·독립인 직렬 await → bulk·`Promise.all`, DB·파일은 서버 측 코드에서만 (15-5)

🟡 — 멤버십·key 조회·우선순위 큐·카운팅에 맞지 않는 자료구조 (15-6) / min·max·상위 k개에 전체 정렬, 반복 linear scan, `sort()` 원본 변이로 state·props 배열 정렬 (15-7) / 큰 데이터(>10K)·hot path의 체인 중간 배열 (15-8) / 루프 안 정규식·상수 테이블·`Intl` 포매터 생성 (15-9) / 큰 N의 루프 내 `str +=` (15-10) / 불필요한 O(N) 보조 공간·N 비례 재귀 깊이·순열 전체 보관 (15-11)

🔵 — brute force·그래프 알고리즘 오선택·내장 함수 복잡도 오인 — 명백히 규모가 크고 성능이 문제 될 때만 (15-12)

**지적하지 않음** — React state 갱신의 `setItems(prev => [...prev, item])`(불변성 요구) (15-3) / 컴포넌트 안 `useMemo` 판단은 14 (15-4) / 작은 배열(<100)의 체인 — 가독성 우선 (15-8) / 구현 난이도·팀 역량을 넘는 알고리즘 강요 (15-12) / diff에 없는 기존 코드 (15 공통)

**지적 원칙**: 병렬화가 shared state write나 순서 의존을 만들면 17을 함께 본다 (15-5)

## 16. API 계약

**적용 조건**: 변경 코드가 request/response shape·HTTP status·error body·route path/param·query default·pagination/sorting/filtering·auth surface·schema/DTO validation·serialization·IPC channel·event/webhook payload·SDK/public export·config/env key·cross-runtime adapter에 닿을 때만 적용한다. **같은 런타임 안에서만 쓰이는 private local helper 시그니처는 contract가 아니다.** 전체 호출자 탐색 없이 diff와 그 변경이 직접 닿는 정의·adapter·mapper·validator·caller만 본다.

**영향 높음**: 기존 caller/consumer가 실제로 깨지거나 검증 실패·external-breakage·권한 흐름 오해를 현재 변경에서 직접 지목할 수 있을 때만. 호환성 증거·migration·adapter 부족에 머물러 깨진 caller나 배포 구간 파손을 닫지 못하면 영향 낮음 — 호환성 불안은 자동으로 높음이 아니다.

🔴 (소비자 관점, 항상 적용) — 타입만 바꾸고 runtime parser·schema·generated client·mapper가 그대로라 wire format과 어긋남, generated 타입 손수정, 직렬화 변환이 한쪽에만, 응답에 없을 수 있는 필드를 필수로 좁힘 (16-1) / 응답 shape·enum 확장·nullable화·에러 응답 shape 변경을 읽는 쪽(컴포넌트·훅·exhaustive 분기·에러 매핑·retry 판정) 미갱신 (16-2) / query key 변경에 `invalidateQueries`·`setQueryData` 미갱신, 같은 리소스를 다른 key로 조회해 캐시 분열, 무효화 key 불일치 (16-3) / route·param·query default·pagination 의미 변경으로 링크·파싱·기존 목록 호출·딥링크/북마크가 깨짐 (16-4)

🔴 (contract 제공자일 때만 적용 — Electron main·BFF·공개 패키지) — field 제거·rename·required화에 기존 caller 호환성 증거 없음, nullable→non-null·enum 축소는 breaking 후보 (16-5) / status·success 판정·error body·error code 변경(`401`↔`403`·retryable 구분 포함)을 기존 caller가 같은 의미로 읽는지 (16-6) / IPC channel·event·payload 변경에 producer·consumer 양쪽 호환성 미확인, env·config key·feature flag name/default·public export·SDK signature 변경에 old key fallback·alias·adapter·migration note가 하나도 없음 (16-7)

🟡 — breaking 가능성이 있는데 versioning·adapter·staged rollout·compatibility layer·migration path 증거가 없음 — 서버·클라이언트가 공존하는 배포 구간을 고려하고, "모든 caller가 같이 바뀐다"는 diff의 caller 변경으로 드러나야 안전 (16-8)

**지적하지 않음** — 타입 안전성 자체는 02 — serialized contract를 깨뜨릴 때만 여기서 (16-1) / 실패 흐름 자체는 exception.md 우선 (16-6) / IPC 경계 위치는 01 — 여기서는 channel·payload 호환성만 (16-7) / 테스트 부재만으로 자동 위반 (16-8) / 권한·데이터 손상·결제·배포 불가 같은 운영 위험은 18 — auth contract 변경이 닿으면 18 지적을 별도로 검토하고 두 축은 지적마다 독립 판정, 18 쪽 위험으로 16 지적의 영향을 올리지 않는다 (16 공통) / 단순 삭제 회귀는 20 (16 공통)

**지적 원칙**: breaking 여부는 이름만이 아니라 wire shape·source·semantic compatibility로 보고, 깨지는 contract 사실을 운영 위험보다 먼저 적는다 (16 공통) / query key 단일 출처는 08-3을 함께 본다 (16-3) / 실패를 성공처럼 보이게 하는 변경은 exception.md를 함께 본다 (16-6)

## 17. 동시성 & 멱등성

**적용 조건**: 변경 코드가 shared state·async request ordering·retry/backoff·외부 부작용·save/delete/payment/mutation·반복 호출 경로·background job·webhook/event consumer·read-modify-write 흐름을 직접 건드릴 때만 적용한다. **read-only GET, 단순 조회, 순수 계산, 표시 전용 로컬 UI에는 적용하지 않고**, 변경 라인·직접 깨진 인접 구조에 트리거가 없으면 동시성 일반론만으로 지적하지 않는다.

**영향 높음**: 중복 결제·저장·삭제, 데이터 손상, lost update, replay 외부 부작용처럼 실제 사고가 닫힐 때만. 안전 증거·직렬화 설명 부족, 예방적 보강에 머물면 영향 낮음.

🔴 — 중복 실행, 두 경로를 섞지 않는다: (a) double click·re-entry·네트워크 retry·이벤트 재전달로 mutation이 두 번 실행될 수 있는데 disabled·pending guard·서버 dedupe 같은 방어 없음 — 재시도·중복 이벤트가 가능하면 클라이언트 disabled만으로 안전하지 않다, (b) mutation이 effect·렌더 경로에 있어 재실행 때 함께 실행 → 이벤트 핸들러로(03-5), effect에 남을 외부 동기화면 cleanup·재실행 안전성(04-1) (17-1) / 느린 이전 응답·out-of-order event가 최신 상태를 덮는데 version·request token·latest-only guard 없음, 쿼리 라이브러리를 두고 수동 `useEffect` + `setState` 페칭 (17-2) / 새 요청·언마운트·route change 뒤 이전 async work가 stale result를 publish하거나 leak(`AbortController`·cleanup 없음), abort를 실제 실패로 다뤄 에러 UI 표시 (17-3)

🔴 (서버 측 코드에만 적용 — Electron main·BFF) — 외부 side effect를 만드는 반복 요청에 stable idempotency key·dedup 경계 없음, 요청마다 랜덤 key, atomic claim 없는 check-then-act (17-5) / non-idempotent operation을 그대로 재호출하는 retry, backoff·timeout·idempotency key 없는 retry, validation/auth/domain error까지 retry (17-6) / read-modify-write에 lock·transaction·CAS·version guard 없음, job·queue·webhook consumer가 replay-unsafe하거나 processed event ID 미영속 — at-least-once에선 중복 전달이 정상 (17-7)

🟡 — optimistic write가 실패·out-of-order·server 응답과 어긋날 때 rollback·reconciliation 없음, 동시 mutation의 rollback이 다른 최신 변경을 지움 (17-4) / 사용자 데이터·결제·저장/삭제·외부 부작용에 직접 닿는데 diff·직접 연결 구조에 안전 증거(guard·lock·idempotency key·transaction·`AbortController`·rollback 등)가 전혀 없음 (17-8)

**지적하지 않음** — StrictMode를 (a) 사용자 경로 중복의 원인(click을 두 번 dispatch하지 않는다)이나 프로덕션 중복 근거(개발 모드 전용)로 적기 — StrictMode에서 mutation이 두 번 돌았다면 지적 대상은 effect/렌더 경로 배치 (17-1) / 테스트 부재만으로 자동 위반, 리뷰 통과용 mock·test·stub 요구 (17-8) / effect cleanup·의존성·리렌더가 핵심이면 04 — 같은 mutation 반복이나 stale async가 외부 부작용으로 이어질 때만 여기 (17 공통) / 예외 전파·fallback·사용자 안내는 exception.md (17 공통) / 권한·데이터 손상·결제·irreversible delete 같은 운영 위험 자체는 18 — 직접 원인이 멱등성·트랜잭션 부재면 여기서 구체적 증거를 요구 (17 공통) / 순수 성능 병렬화·N+1 I/O는 15 (17 공통)

**지적 원칙**: 변경 흐름과 직접 연결된 호출부·handler·persistence boundary·cleanup만 본다 — 저장소 전체로 넓히지 않는다 (17 공통) / 사용자 경로 중복과 effect 경로 중복은 분리해 적는다 (17-1)

## 18. 위험 변경

**적용 조건**: 변경 라인이 인증·인가·권한·세션·토큰 / 결제·주문·정산·크레딧·쿼터 소비 / 저장·삭제·덮어쓰기·마이그레이션·스키마 변경 / 파일 쓰기·OS API·Electron main의 시스템 접근 / 배포 산출물 동작을 바꾸는 config·env·feature flag 기본값 / 개인정보·민감정보의 저장·전송·로깅 경로에 닿을 때만 적용한다. **읽기 전용 조회, 표시 전용 UI, 순수 계산에는 적용하지 않는다.**

**영향 높음**: 데이터 손실·권한 우회·잘못된 과금·복구 경로 상실·배포 즉시 장애 중 하나를 현재 변경에서 직접 지목할 수 있을 때만. 안전 증거 부족이 그 범주로 곧바로 이어진다고 아직 닫지 못했으면 영향 낮음 — 위험 영역을 건드린 것만으로 높음이 아니다. 16·17과 겹치면 그쪽 등급을 복사하지 말고 별도 지적으로 두 축을 독립 판정한다.

🔴 — 클라이언트 gating만 바꾸고 서버·Electron main 권한 검사는 그대로, 역할·스코프·테넌트 판정 변경에 거부 경로(`401`/`403`) 미갱신, 토큰·세션·쿠키 저장 위치·만료 변경에 갱신·로그아웃 흐름 불일치, 권한 검사를 우회하는 새 진입점(딥링크·IPC 채널·공개 export) (18-1) / 삭제·덮어쓰기·초기화에 확인·되돌리기·소프트 삭제 없음, 부분 실패 시 일부만 적용되고 복구 경로 없음, 마이그레이션에 호환성·롤백·재실행 안전성 증거 없음, 로컬 저장소(localStorage·IndexedDB·파일) 스키마 변경에 기존 값 처리 없음 (18-2) / 금액·수량·통화·할인 계산 변경에 검증·서버 재확인 없음, 재시도·중복 실행 방어 없음(17의 멱등성 증거 함께 요구), 실패가 성공처럼·성공이 실패처럼 보임 (18-3) / 토큰·비밀번호·개인정보가 로그·에러 메시지·URL·분석 이벤트에 포함, 서버 전용 값을 클라이언트 번들 env 키로 옮김, 에러 응답 원문을 UI에 노출 (18-4)

🟡 — feature flag 기본값 변경으로 같은 산출물이 다르게 동작, env/config 키 rename에 old key fallback·마이그레이션 안내 없음, 빌드 타깃·런타임 버전·번들 설정 변경의 영향 범위가 diff에서 안 드러남 (18-5) / 위험 흐름 변경인데 안전 증거(스키마 검증·권한 재확인 위치·확인/되돌리기/소프트 삭제·멱등성 키/트랜잭션/버전 가드·단계적 롤아웃/flag/롤백 절차·실패 복구 경로와 안내)가 diff나 직접 연결된 인접 구조에 **하나도** 없음 (18-6)

**지적하지 않음** — 테스트 부재만으로 위반을 만들지 않고, 리뷰 통과용 mock/test 추가를 요구하지 않는다 (18-6) / 중복 실행·순서 역전·lost update의 구체적 방어책은 17, 실패 전파·fallback·사용자 안내 자체는 `exception.md`가 우선 (18-3) / 단순 삭제 회귀는 20이 우선 (18-2) / contract shape·semantics 호환성 자체는 16이 우선 — 그 변경이 권한·데이터·과금 위험으로 이어질 때만 여기서 별도 위험 지적을 검토 (18 공통)

**지적 원칙**: UI에서 버튼을 숨기는 것은 권한 통제가 아니다 — 실제 판정 위치를 확인한다 (18-1)

## 19. 의도 & 선택 근거

**영향 높음**: 문제 정의와 구현 선택의 불일치가 실제 오동작·외부 파손·검증 실패로 닫힐 때만. 의도 표현·트레이드오프 설명·선택 근거 보강에 머물면 영향 낮음.

🔴 — 단순한 요구에 과도한 추상화·범용화·설정화, 복잡한 문제를 임시 우회로 눌러 다음 변경에서 쉽게 깨짐, 증상만 가리고 원인·경계 조건은 그대로, 호출자 문제 대신 구현 편의 중심 API (19-1) / 성능·단순성·일관성·확장성 중 하나를 크게 희생하거나 메모리·복잡한 일반화를 택하고 근거 없음, strict 검증 대신 관대한 허용에 운영상 안전장치 없음, 비표준 패턴·workaround에 필요 이유·제거 시점 없음 (19-2)

🟡 — 코드·이름·주석·리뷰 설명으로 "왜 있는지" 파악 불가, 일반적인 이름에 더 좁거나 위험한 실제 역할, 중요한 분기·예외 처리가 도메인 규칙인지 임시 방어인지 구분 안 됨 (19-3) / 로컬 로직이면 충분한데 전역 상태·추상 레이어·설정 구조, 사용처 하나인데 재사용 프레임워크처럼 설계, 이점 불분명한 커스텀 패턴, React 기본 동작(`key` 리셋·렌더 중 파생·Suspense)을 근거 없이 수동 구현, 팀 기존 패턴 이탈의 가치 불명 (19-4) / 다음 수정자가 여러 암묵적 전제를 알아야 안전하게 바꿀 수 있음, 확장 포인트처럼 보이나 한 곳만 위한 특수 규칙, 요구가 조금 바뀌어도 여러 군데 수정 필요, 삭제 가능 여부·영향 범위 판단이 어려움 (19-5)

🔵 — 복잡도·캐시·debounce·batching·fallback·feature flag 선택 이유, 우회 경로의 제거 조건·재검토 시점, 성능·단순함·확장성 우선순위를 남기면 좋음 (19-6)

**지적하지 않음** — 순수 타입 문법 오류·import 누락·dead code(02·09), 레이어 위치 자체의 아키텍처 규칙(01), 순수 알고리즘 Big-O(15), 원칙 이름 붙이기(10)는 이 모듈 범위가 아니다 (19 공통)

**지적 원칙**: 취향 비평("마음에 들지 않는다")이 아니라 문제 → 현재 선택 → 왜 불충분한지 → 개선 방향으로 적는다 (19 공통) / 작성자 의도를 추측해 단정하지 않고 코드·이름·주석·변경 설명의 검증 가능한 근거로만 선택 불일치를 말한다 (19-1, 19-2) / 의도가 나쁘다고 단정하지 말고 의도가 검증 가능하게 표현되지 않았다고 지적한다 (19-3) / 더 단순한 대안은 무엇을 잃고 얻는지까지 함께 제안한다 (19-4)

## 20. 삭제 회귀

**영향 높음**: 필요한 production code·contract path·cleanup·boundary가 실제로 사라져 사용자 오동작·검증 실패·외부 파손이 닫힐 때만. 삭제 의도는 보이나 이동·대체·정리 증거가 부족하거나, 회귀 가능성은 있으나 실제 파손 범주를 아직 닫지 못했으면 영향 낮음 — 단순 삭제 자체는 자동 높음이 아니다.

🔴 — 삭제 항목이 production export·function·type·constant·helper·runtime config·schema·API contract면 회귀를 우선 의심 (20-1) / production 삭제를 자동 안전으로 보지 않음 — 기능은 유지되는데 구현·호출 경로만 사라짐, 공통 helper 삭제 후 같은 로직이 여러 파일로 흩어짐, schema·API·event·serialization 계약은 유지되는데 타입·상수·변환 코드만 사라짐, 대체 호출부 변경이 diff에 없음 — 이동·통합이면 새 위치와 대체 호출 경로가 diff에 보여야 함 (20-2) / 삭제된 export·function·type·constant가 여전히 참조됨, 직접 참조가 없어도 런타임 경로에 필요·공통 처리 역할 상실로 중복 증가·숨은 계약(API·schema·이벤트·직렬화 포맷) 파손 (20-3) / `useEffect` cleanup 반환 삭제(구독·타이머 누수), 의존성 배열 항목 삭제(재실행 누락·stale closure), `key` 삭제·값 변경(재마운트·상태 오매칭), `Suspense`/Error Boundary 경계 삭제(로딩·실패가 상위로 전파), `memo`/`useMemo` 제거는 대개 안전하나 그것에 기댄 참조 동등성 로직 확인 (20-4)

🟡 — 삭제만 있고 대체·이관·설명 증거가 없으면 회귀 후보 (20-5)

**지적하지 않음** — `__test__`·`__tests__`·`*.test.*`·`*.spec.*`·`__mocks__`·mock/mocks·fixture/mock data 전용 파일 삭제 (20-1) / 같은 책임 코드의 이동, 리네임·모듈 통합, 호출부·import·export 동반 갱신, 제품 요구사항에 명시된 기능 제거가 보이는 합법적 삭제 — 명확한 정리는 대체로 영향 낮음 또는 생략 (20-5) / 리뷰 중 새 mock/test 추가 요구 (20 공통)

**지적 원칙**: 제거된 파일과 `-` 라인부터 보되, 정리인지 동작 제거인지 diff만으로 판단하지 말고 변경 전후 흐름까지 확인한다 (20-1) / 삭제된 파일·심볼에 한한 targeted reference check만 — 저장소 전체를 넓게 훑지 않고, tests pass 여부만으로 안전성을 판단하지 않는다 (20-3) / production인지 리뷰 제외 대상인지 먼저 분류하고 대체 경로·이동·리네임·호출부 수정 동반 여부를 본다 — 필요한데 사라졌으면 높은 영향 근거를 검토, 의도는 보이나 증거가 약하면 영향 낮음 근거 (20-1, 20-5) / public contract 제거면 16의 versioning·deprecation 증거도 확인 (20-3) / 권한·데이터·과금 흐름에 닿는 삭제는 18 쪽 별도 지적을 검토하고 두 축은 각 지적에서 독립 판정 (20 공통)

## 21. RSC & Server/Client 경계 *(RSC 프로젝트 전용)*

**적용 조건**: RSC 지원 프레임워크를 쓰는 프로젝트에만 — 저장소의 `'use client'`/`'use server'` 지시어, Next.js App Router·React Router framework mode·Waku 등 RSC 지원 프레임워크 설정, 번들러·프레임워크 설정의 RSC 활성화 중 하나 이상이 확인될 때만 적용하고, 확인되지 않으면 모듈 전체를 `SKIPPED`로 둔다. **Vite + SPA·CRA·Electron renderer 전용처럼 서버 컴포넌트 개념이 없는 프로젝트, RSC 아닌 SSR(Next.js Pages Router 등)에는 적용하지 않는다** — 그 경우 hydration은 03-8이 다룬다.

**영향 높음**: 서버 비밀 유출·권한 우회·빌드/런타임 실패·직렬화 크래시를 직접 지목할 수 있을 때만. 클라이언트 번들 비대화·경계 오배치·과도한 payload·guard 부족은 회귀 위험이 있어도 영향 낮음 — 단순 bundle size·구조·명확성 문제만으로는 높음이 아니다.

🔴 — 서버 컴포넌트로 만들려고 `'use server'`를 붙여 파일 export 전부가 클라이언트 호출 가능 endpoint가 됨, Server Function 아닌 값(상수·타입·일반 객체)을 `'use server'` 파일에서 export (21-2) / 서버→클라이언트 props로 함수·클래스 인스턴스·`Date` 외 커스텀 객체·`Map`/`Set`·Symbol·순환 참조, 서버에서 만든 이벤트 핸들러 전달(Server Function은 예외) (21-3) / API 키·DB 접속 문자열·내부 토큰이 클라이언트 컴포넌트가 읽는 경로에 있음, `NEXT_PUBLIC_` 등 클라이언트 노출 env에 비밀값, DB 클라이언트·파일시스템·서버 SDK를 `'use client'` 경계 아래에서 import (21-4) / 인증·인가 없이 읽고 쓰는 Server Function, 클라이언트가 보낸 ID를 검증 없이 신뢰(IDOR), `FormData`·인자를 런타임 검증 없이 DB·외부 API로 전달 (21-5)

🟡 — 트리 상단(레이아웃·페이지 루트)의 `'use client'`로 하위 전체가 클라이언트로 끌려감, 상호작용 부분만 분리하면 될 큰 컴포넌트 전체 전환, `'use client'` 파일이 무거운 서버 전용 유틸(파싱·마크다운·날짜 라이브러리)을 import해 번들 유입 (21-1) / Server Function 파일에 클라이언트가 부를 필요 없는 내부 헬퍼 export (21-2) / 몇 필드면 될 거대한 서버 객체 통째 전달, ORM 엔티티·DB row를 가공 없이 전달해 내부 필드 노출 (21-3) / 서버 전용 모듈에 `server-only` 같은 가드 없음 (21-4) / 호출자가 UI에서 가려졌다는 이유로 권한 검사 생략 (21-5) / 서버 컴포넌트에서 `useState`·`useEffect`·이벤트 핸들러·브라우저 API, 클라이언트 컴포넌트에서 서버 async 데이터 접근을 흉내 낸 최상위 `await`, 서버 컴포넌트에 둔 Context Provider로 클라이언트 소비자가 값을 못 받음 (21-6)

🔵 — 지시어가 파일 최상단이 아니거나 중복 선언 (21-1) / 서버 컴포넌트에 불필요한 `'use client'` 하위 wrapper가 겹겹이 쌓임 (21-6)

**지적하지 않음** — hydration 불일치 자체(03-8), FSD 레이어 배치·Electron 프로세스 경계(01), 요청 shape·payload 호환성(16) (21 공통) / 권한 검사 누락의 운영 위험 등급은 18-1과 함께 본다 (21-5) / diff에 없는 기존 코드 (21 공통)

**지적 원칙**: `'use client'`는 "여기부터 아래 전부가 클라이언트 번들" — 상태·이벤트 핸들러를 쓰는 최소 단위만 클라이언트에 두고 나머지를 `children`으로 주입해 경계를 아래로 밀 수 있으면 지적, 새 `'use client'` 파일의 import는 한 단계 따라가 번들 유입 확인 (21-1) / `'use server'` 함수는 네트워크에 노출된 공개 endpoint — 같은 파일에 있다고 내부 함수로 보지 않는다 (21-2) / 전달값이 JSON 직렬화 가능하거나 React 지원 특수 타입(Server Function 참조·Promise·JSX)인지 보고, 크래시와 별개로 필요 이상 필드는 payload·노출 양쪽에서 지적 (21-3) / 클라이언트가 읽는 경로 도달은 import 체인으로 확인 — "서버에서만 쓸 의도" 주석은 증거가 아니다 (21-4) / 권한 검사는 Server Function **안에서** — 호출 컴포넌트 gating은 UI 편의일 뿐 보안 경계가 아니고 폼에서만 호출한다는 사실은 아무것도 보장하지 않는다, 새 Server Function마다 인증·입력 검증·인자 조작 시 남의 데이터 도달 여부를 묻는다 (21-5)

---

## 출력 형식

| 심각도 | 규칙 | 위치 | 영향 · 확신 | 이슈 | 개선 방향 |
|--------|------|------|-------------|------|-----------|
| 🔴/🟡 | 03-1 | 파일:라인 + 인용 | 영향: 높음 (데이터 손상) · 확신: 높음 | 발생 조건 → 호출·소비 경로 → 잘못되는 결과 | 짧은 수정 방향 |

**원칙**

- 영향 높음 지적만 낸다. 개수 상한은 없다
- 위반 없는 파일은 상세 표에 포함하지 않음
- 영향이 낮은 지적(단순 스타일·반복 지적·사용자에게 닿지 않는 차이)은 생략
- diff에 없는 기존 코드 지적 금지, 추측 금지. 단 diff가 삭제·변경한 심볼을 아직 참조하는 diff 밖 호출부는 그 변경 때문에 깨진 구조라 20. 삭제 회귀의 근거로 인용한다 (targeted reference check, 00-3)
