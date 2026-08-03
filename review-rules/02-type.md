# 타입 안전성

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
