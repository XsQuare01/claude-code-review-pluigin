# 타입 안전성

이 모듈은 **타입이 실제로 무엇을 보장하는지**를 본다. 타입은 컴파일러 설정이 켜져 있는 만큼만 보장하고, 값이 프로그램 밖에서 들어오는 지점에서는 아무것도 보장하지 않는다. 두 사실을 무시한 규칙은 안전하지 않은 코드를 통과시키거나 안전한 코드를 지적한다.

## 리뷰 전 확인: tsconfig

**같은 코드라도 컴파일러 설정에 따라 안전 여부가 달라진다.** 리뷰를 시작하기 전에 프로젝트의 `tsconfig.json`(및 상속 체인)에서 아래를 확인하고, 확인된 설정을 기준으로 판정한다. 설정을 확인하지 않은 채 "이 접근은 위험하다"고 판단하면 이미 컴파일러가 막고 있는 것을 지적하거나, 반대로 컴파일러가 안 막는 것을 안전하다고 넘긴다.

| 설정 | 꺼져 있을 때 리뷰가 대신 봐야 하는 것 |
|------|--------------------------------------|
| `strict` / `strictNullChecks` | null·undefined 접근 전반. narrowing 규칙(02-5)의 판정 강도를 올린다 |
| `useUnknownInCatchVariables` | `catch (e)`의 `e`가 `any`다. `e.message` 직접 접근을 지적한다 |
| `noUncheckedIndexedAccess` | `arr[i]`, `record[key]`가 `undefined`일 수 있다. 인덱스 접근 후 바로 사용하는 코드를 지적한다 |
| `exactOptionalPropertyTypes` | `{ x?: string }`에 명시적 `undefined`를 넣는 코드가 통과한다 |
| `noImplicitReturns` | 일부 분기에서만 값을 반환하는 함수가 통과한다 |
| `strictFunctionTypes` | 콜백 파라미터 반공변 검사가 없다 (02-13) |
| `verbatimModuleSyntax` | 타입 전용 import의 소거 동작이 달라진다 (02-12) |

**TypeScript 버전도 확인한다.** 새 버전의 기본값이나 새 문법을 이전 버전 프로젝트에 요구하지 않는다. 없는 기능을 쓰라는 지적은 개선 제안이 아니라 오탐이다.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 런타임 에러 가능, 타입 시스템 무력화 |
| 🟡 WARNING | 타입 불일치, 잠재적 버그 |
| 🔵 INFO | 더 정확한 타입 표현 가능 |

---

## 02-1. 타입 우회

타입 우회는 존재 자체가 위반이 아니다. **우회가 어디까지 번지는지**로 판정한다. 경계 한 곳에 갇혀 있고 검증된 타입으로 나오는 우회는 정당한 도구이고, 앱 타입으로 흘러 들어가 다른 코드의 검사까지 무력화하는 우회가 문제다.

판정할 때 다음을 본다.

- **범위**: 함수 한 줄인가, exported 타입인가
- **소비 위치**: 우회한 값이 검증 없이 앱 내부로 전파되는가
- **사유**: 왜 우회가 필요한지가 코드나 주석에서 드러나는가
- **제거 조건**: 언제 없앨 수 있는지가 특정 가능한가 (라이브러리 타입 수정, 버전 업 등)

| 대상 | Severity | 판정 |
|------|----------|------|
| 근거 없는 타입 단언 (`as User` — narrowing도 런타임 검증도 없음) | 🔴 | 항상 위반 |
| `as unknown as T` 이중 단언 | 🔴 | 항상 위반. 검사를 완전히 우회하고 컴파일러가 불일치를 더 못 잡는다 |
| catch-all Props (`[key: string]: any`) | 🔴 | 항상 위반. 오타와 잘못된 prop이 전부 통과한다 |
| `any`가 exported 타입/public 시그니처/앱 내부로 전파 | 🔴 | 위반 |
| `any`가 미타입 외부 경계에 격리되고 검증된 타입으로 반환 | 🔵 | 사유 주석만 확인. 위반 아님 |
| `@ts-ignore` | 🔴 | 위반. 오류가 사라져도 조용히 남아 썩는다. `@ts-expect-error`로 교체 |
| `@ts-expect-error` + 사유·제거 조건 | 🔵 | 위반 아님 |
| `@ts-expect-error` 사유 없음 | 🟡 | 사유·owner·제거 조건 요구 |

`@ts-expect-error`를 `@ts-ignore`와 같은 등급으로 취급하지 않는다. 오류가 사라지면 그 자리에서 컴파일이 실패하는 **검증 가능한 suppression**이고, 타입 음성 테스트(잘못된 사용이 실제로 타입 에러인지 확인)나 추적 중인 외부 타입 결함에서는 정상적인 도구다.

```typescript
// ❌ 근거 없는 단언 — 런타임에 무엇이 오는지 아무도 모른다
const data = response as User

// ❌ 오류가 없어져도 조용히 남는다
// @ts-ignore
legacy.doThing(payload)

// ✅ 경계에서 unknown으로 받고 검증해서 내보낸다
function parse(input: unknown): User {
  if (!isUser(input)) throw new Error('Invalid')
  return input
}

// ✅ 격리된 any — 외부 미타입 SDK를 어댑터 한 곳에서만 만지고 검증된 타입으로 반환
function toUser(raw: any): User {          // eslint-disable-line @typescript-eslint/no-explicit-any
  return userSchema.parse(raw)             // any는 이 함수 밖으로 나가지 않는다
}

// ✅ 검증 가능한 suppression — 라이브러리가 고쳐지면 컴파일이 실패해서 알려준다
// @ts-expect-error upstream types wrong, see DefinitelyTyped#12345 — 제거 조건: @types/foo >= 3.2
widget.setOptions({ mode: 'compact' })
```

## 02-2. Props 타입 표현 🟡

**exported/public boundary와 파일 내부 local 컴포넌트를 구분한다.** 다른 모듈이 소비하는 컴포넌트의 Props는 이름이 있어야 문서화·재사용·확장이 가능하다. 같은 파일에서만 쓰이는 작은 컴포넌트의 인라인 Props는 위반이 아니다.

- 🟡 exported 컴포넌트의 Props가 인라인이라 외부에서 참조할 이름이 없음
- 🟡 children 타입이 실제 사용과 어긋남 (`ReactNode`여야 하는데 `string`, 또는 그 반대)
- 🔵 파일 내부 local 컴포넌트의 인라인 Props → 지적하지 않음
- 🔵 `FC<Props>` vs 직접 선언은 프로젝트 관례를 따르는지만 확인. 관례가 없으면 지적하지 않음

**이벤트 핸들러 타입은 contextual typing이 끊긴 경우에만 요구한다.** JSX 속성에 직접 인라인으로 쓴 핸들러는 React가 이미 타입을 추론하므로 명시가 중복이다.

```typescript
// ✅ contextual typing이 살아 있다 — e는 이미 React.MouseEvent<HTMLButtonElement>
<button onClick={e => e.currentTarget.blur()} />

// 🟡 contextual typing이 끊겼다 — 여기서는 명시가 필요
const handleClick = (e) => { ... }        // e가 implicit any
<button onClick={handleClick} />

// ✅ 끊긴 자리에 명시
const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => { ... }
```

## 02-3. 타입 복잡도 🟡

아래 수치는 **자동 위반이 아니라 추출을 검토할 신호**다. 임계값을 넘었다는 사실만으로 지적하지 않고, 이름이 없어서 읽기 어렵거나 중복되는지를 함께 본다.

- 인라인 타입이 커져 시그니처만으로 의미를 못 읽음 (필드 3개 초과가 신호)
- 유틸리티 타입 중첩이 깊어 최종 형태를 추론하기 어려움 (3단 이상이 신호)
- 이름 없는 유니온 멤버가 많아 각 갈래의 의미가 드러나지 않음 (5개 초과가 신호)

같은 인라인 타입이 두 곳 이상에 복제돼 있으면 수치와 무관하게 지적한다.

```typescript
// ❌ BAD
function process(
  data: { id: string; name: string; items: Array<{ sku: string; qty: number }> },
): Promise<Partial<Pick<typeof data, 'id'>> & { success: boolean }> { ... }

// ✅ GOOD
interface OrderPayload { id: string; name: string; items: OrderItem[] }
interface ProcessResult { id: string; success: boolean }
function processOrder(data: OrderPayload): Promise<ProcessResult> { ... }
```

## 02-4. API 응답-Props 타입 정합성 🟡

- API가 `null` 반환 가능인데 Props에서 non-optional로 정의된 필드
- 수동 캐스팅으로 타입 불일치를 숨기는 경우
- optional(`?`) 남용 — 실제로 필수인 필드가 느슨하게 정의
- snake_case ↔ camelCase 변환 누락

타입 정의만 바뀌고 런타임 파서/스키마가 그대로면 `16-api-contract.md`를 함께 본다.

## 02-5. 유니온 타입 Narrowing 🟡

- `data: User | null`에서 null 체크 없이 `data.name` 접근
- discriminated union 분기 누락 (exhaustive check 없음)
- `?.`로 문제를 숨기는 대신 명시적 분기가 필요한 케이스

```typescript
// ❌ BAD
function Profile({ user }: { user: User | null }) {
  return <span>{user.name}</span>  // null이면 런타임 에러
}

// ✅ GOOD
function Profile({ user }: { user: User | null }) {
  if (!user) return <EmptyState />
  return <span>{user.name}</span>
}
```

## 02-6. Discriminated Union 가독성 🟡

- 판별자(discriminant) 필드 불일치 (`kind` vs `type` 혼용)
- exhaustive check 없는 switch문
- exhaustive helper 미사용

```typescript
// ✅ exhaustive check
default: return action satisfies never
```

## 02-7. 제네릭 🟡

제네릭은 `extends` 제약이 있는지가 아니라 **입력과 출력 사이의 관계를 실제로 보존하는지**로 판정한다.

- 🟡 type parameter가 한 번만 등장해 관계를 보존하지 않음 → 그냥 `unknown` 파라미터로 충분한데 제네릭으로 위장한 경우
- 🟡 함수 본문이 요구하는 capability(속성 접근, 호출, 인덱싱)가 제약에 반영되지 않아 내부에서 단언으로 우회
- 🟡 제네릭 파라미터가 3개 이상인데 단일 문자라 각 역할을 못 읽음
- 🔵 제약 없는 `T`가 값을 그대로 통과시키기만 함 → 정상. 제약을 붙일 이유가 없다

제약 없는 `T`를 `unknown`과 동일하다고 보지 않는다. 함수 **본문 안에서는** `T`를 `unknown`처럼 다뤄야 하는 것이 맞지만, 호출부에서는 `T`가 구체 타입으로 고정되어 입력 타입이 반환 타입까지 이어진다. 이 관계 보존이 제네릭의 목적이다.

```typescript
// ❌ 관계를 보존하지 않는다 — T가 한 번만 등장하고 반환은 any
function log<T>(value: T): any { ... }

// ✅ 제약이 없어도 관계를 보존한다 — 입력 타입이 반환 타입으로 이어진다
function identity<T>(value: T): T { ... }

// ❌ 본문이 요구하는 capability가 제약에 없어 단언으로 우회
function getId<T>(item: T): string {
  return (item as { id: string }).id
}

// ✅ 필요한 capability를 제약으로 표현
function getId<TItem extends { id: string }>(item: TItem): string {
  return item.id
}
```

## 02-8. 함수 반환 타입 🔵

- public 함수/훅 반환 타입 명시 여부
- 커스텀 훅이 배열을 반환할 때 `as const` 없이 튜플 의도가 깨짐
- 미사용 타입 정의

## 02-9. 신뢰 경계와 런타임 검증 🔴

프로그램 밖에서 들어오는 값에는 **타입 선언이 아무것도 보장하지 않는다.** 선언은 개발자의 기대일 뿐이고, 실제로 오는 것은 서버가 보낸 것이다. 신뢰 경계에서는 타입을 붙이는 것과 값을 확인하는 것이 완전히 다른 일이라는 점이 핵심이다.

**신뢰 경계 목록** — 이 경계를 넘어 들어오는 값은 전부 미검증으로 본다.

- 네트워크 응답 (`fetch`, axios, WebSocket, SSE)
- `localStorage`, `sessionStorage`, IndexedDB, 쿠키
- URL query/param, `location.hash`, postMessage, 브라우저 확장 메시지
- 환경 변수, 런타임 config, feature flag 원본
- 파일 입력, 클립보드, 드래그앤드롭 데이터
- Electron IPC payload, 서버 → 클라이언트 직렬화 경계 (`21-rsc.md`와 함께 본다)

**판정**

- 🔴 위 경계에서 받은 값에 검증 없이 타입 단언·제네릭 인자로 타입을 부여하고 그대로 사용 (`await res.json() as User`, `JSON.parse(raw) as Config`)
- 🔴 `localStorage`에서 읽은 값을 파싱만 하고 shape 확인 없이 state·store에 주입 — 이전 버전이 남긴 낡은 shape가 그대로 들어온다
- 🔴 env·config 값을 `string`으로 단정하고 사용 (없으면 `undefined`다)
- 🟡 런타임 스키마는 있는데 실제 사용처가 스키마 결과가 아니라 원본 값을 씀
- 🟡 generated 타입(OpenAPI, GraphQL codegen)과 런타임 스키마가 각각 관리되어 서로 어긋날 수 있는데 정렬 근거가 없음 — 계약 자체의 호환성은 `16-api-contract.md` 16-1

**요구하는 것은 특정 라이브러리가 아니다.** `unknown`으로 받아 type guard로 좁히는 것, 스키마 라이브러리로 parse하는 것, 수동 검증 함수를 통과시키는 것 모두 유효하다. 요구하는 것은 **검증되지 않은 값이 검증된 타입 이름을 달고 앱 내부로 들어가지 않는 것**이다.

```typescript
// ❌ 이름만 User다 — 서버가 무엇을 보냈는지 아무도 확인하지 않았다
const user: User = await res.json()

// ❌ 낡은 shape가 그대로 복원된다
const draft = JSON.parse(localStorage.getItem('draft')!) as Draft

// ✅ 경계에서 검증하고, 검증된 값만 안으로 보낸다
const user = userSchema.parse(await res.json())
```

## 02-10. 단언 안전성 🔴

단언은 컴파일러에게 "내가 안다"고 말하는 것이다. 그 주장이 틀리면 컴파일러는 더 이상 도와주지 않는다. 02-1이 단언의 **범위**를 본다면, 이 규칙은 단언의 **근거**를 본다.

- 🔴 non-null 단언(`!`)의 근거가 코드에 없음 — 앞선 검사, 불변식, 초기화 순서 중 무엇도 그 값이 있음을 보장하지 않는다
- 🔴 assertion function(`asserts x is T`)의 구현이 실제로 검사하지 않고 통과만 시킴 — 시그니처는 보장을 약속하는데 본문이 지키지 않으면 호출부 전체가 잘못된 전제 위에 선다
- 🔴 `satisfies`나 타입 선언을 런타임 검증으로 오해 — `satisfies`는 값이 타입에 맞는지 **컴파일 시점**에만 확인한다. 외부 입력에는 아무 효력이 없다 (02-9)
- 🟡 `!`가 연쇄로 붙어 어느 지점의 가정이 깨졌는지 추적 불가 (`a!.b!.c!`)
- 🟡 optional chaining으로 문제를 숨긴 자리에 단언을 덧붙여 의도가 모순됨 (`obj?.x!`)
- 🔵 테스트 코드나 초기화 직후처럼 불변식이 명확한 자리의 `!` → 지적하지 않음

```typescript
// ❌ 시그니처는 보장하는데 본문이 검사하지 않는다
function assertUser(v: unknown): asserts v is User {
  if (!v) throw new Error('missing')      // 객체 shape는 확인하지 않았다
}

// ✅ 약속한 만큼 검사한다
function assertUser(v: unknown): asserts v is User {
  if (!isUser(v)) throw new Error('invalid user')
}
```

## 02-11. 컴파일러 설정에 기댄 판정 🟡

리뷰 판정이 프로젝트 설정과 어긋나면, 있지도 않은 보장을 전제하거나 이미 있는 보장을 중복 지적한다. 리뷰 전 확인 표에 정리한 설정을 기준으로 본다.

- 🟡 `strictNullChecks`가 꺼져 있는데 null 안전성을 컴파일러가 잡아준다고 전제
- 🟡 `noUncheckedIndexedAccess`가 켜져 있는데 인덱스 접근 결과를 바로 사용 (`items[0].name`)
- 🟡 `useUnknownInCatchVariables`가 꺼져 있어 `catch (e)`의 `e`가 `any`인데 `e.message`를 그대로 사용
- 🟡 `exactOptionalPropertyTypes`가 켜져 있는데 optional 필드에 명시적 `undefined`를 넘김
- 🔵 프로젝트가 이미 켠 설정 덕분에 컴파일러가 잡는 항목을 리뷰 지적으로 중복 나열

**변경된 코드가 tsconfig 자체를 건드린 경우**는 별도로 본다. strict 계열 옵션을 끄거나 `skipLibCheck`·`ignoreDeprecations`를 새로 켜는 변경은 검사 범위를 줄이는 결정이므로, 왜 필요한지와 언제 되돌릴지가 함께 있어야 한다.

## 02-12. 타입 import와 모듈 의미 🟡

- 🟡 타입만 쓰는 import에 `import type`을 쓰지 않아 런타임 import가 남고 번들·순환 참조·사이드이펙트에 영향
- 🟡 `verbatimModuleSyntax`가 켜진 프로젝트에서 값과 타입을 한 import 구문에 섞음
- 🟡 재수출 barrel에서 타입과 값을 구분하지 않아 소비자가 무엇을 런타임에 쓰는지 알 수 없음
- 🔵 FSD 레이어 경계를 `import type`으로 우회하는 경우 → 경계 위반 자체는 `01-fsd.md` 01-1

## 02-13. 함수·콜백 variance 🟡

- 🟡 콜백 파라미터를 더 넓은 타입으로 받아야 하는데 좁게 선언해 호출부가 단언으로 우회
- 🟡 `strictFunctionTypes`가 켜진 프로젝트에서 함수 프로퍼티 대신 메서드 문법으로 선언해 반공변 검사를 피함 — 검사를 의도적으로 피한 것인지 확인한다
- 🟡 이벤트 핸들러 타입을 구체 엘리먼트로 좁혀 재사용 시마다 단언이 필요해짐
- 🔵 반환 타입을 넓게 선언해 호출부가 다시 좁혀야 함

## 02-14. React API 타이핑 🟡

- 🔴 `ref`의 엘리먼트 타입이 실제 부착 대상과 달라 `current` 접근이 런타임에 어긋남 (`useRef<HTMLDivElement>`인데 `<input>`에 부착)
- 🟡 callback ref가 cleanup 함수를 반환하지 않거나, 반환값 타입이 맞지 않아 정리 시점이 불명확
- 🟡 polymorphic `as` 컴포넌트가 대상 엘리먼트의 intrinsic prop과 충돌 — 자체 prop 이름이 DOM prop을 가려 잘못된 속성이 전달됨
- 🟡 이벤트에서 `target`과 `currentTarget`을 혼동 — `target`은 실제 이벤트 발생 엘리먼트라 위임 상황에서 기대한 타입이 아니다. 핸들러를 붙인 엘리먼트가 필요하면 `currentTarget`을 쓴다
- 🔵 children 타입이 실제 사용과 어긋남 → 02-2와 함께 본다

```typescript
// ❌ target은 내부 span일 수도 있다
<button onClick={e => (e.target as HTMLButtonElement).disabled = true} />

// ✅ 핸들러를 붙인 엘리먼트
<button onClick={e => { e.currentTarget.disabled = true }} />
```
