# 타입 안전성 & 가독성

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 런타임 에러 가능, 타입 시스템 무력화 |
| 🟡 WARNING | 타입 불일치, 잠재적 버그 |
| 🔵 INFO | 더 정확한 타입 표현 가능 |

---

## 1-1. 타입 우회 금지 🔴

- `any` 사용 → `unknown` + type guard로 대체
- `@ts-ignore`, `@ts-expect-error` 주석
- 근거 없는 타입 단언 (`as User` — narrowing 없이)
- catch-all Props (`[key: string]: any`)

```typescript
// ❌ BAD
const data = response as User
function parse(input: any) { ... }

// ✅ GOOD
function parse(input: unknown): User {
  if (!isUser(input)) throw new Error('Invalid')
  return input
}
```

## 1-2. Props 인터페이스 명시성 🔴

- 인라인 타입 대신 named interface/type 사용
- 이벤트 핸들러 타입 명시 (`(e: React.MouseEvent<HTMLButtonElement>) => void`)
- children 타입 적절성 (`ReactNode` vs `string` vs `ReactElement`)

## 1-3. API 응답-Props 타입 정합성 🟡

- API가 `null` 반환 가능인데 Props에서 non-optional로 정의된 필드
- 수동 캐스팅으로 타입 불일치를 숨기는 경우
- optional(`?`) 남용 — 실제로 필수인 필드가 느슨하게 정의
- snake_case ↔ camelCase 변환 누락

## 1-4. 유니온 타입 Narrowing 🟡

- `data: User | null`에서 null 체크 없이 `data.name` 접근
- discriminated union 분기 누락 (exhaustive check 없음)
- `?.`로 문제를 숨기는 대신 명시적 분기 필요한 케이스

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

## 1-5. 함수 반환 타입 & 제네릭 🔵

- public 함수/훅 반환 타입 명시 여부
- 제네릭 제약 조건 유무 (`<T>` → `<T extends BaseEntity>`)
- 미사용 타입 정의

---

## 2-1. 타입 복잡도 🔴

- 인라인 타입 3개 필드 초과 → named type 추출
- 유틸리티 타입 3단 이상 중첩 (`Partial<Pick<Omit<...>>>`)
- 이름 없는 유니온 멤버 5개 초과

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

## 2-2. Discriminated Union 가독성 🟡

- 판별자(discriminant) 필드 불일치 (`kind` vs `type` 혼용)
- exhaustive check 없는 switch문
- `satisfies never` 또는 exhaustive helper 미사용

```typescript
// ✅ exhaustive check
default: return action satisfies never
```

## 2-3. 제네릭 가독성 🟡

- 단일 문자 제네릭이 문맥 없이 사용 (`T`, `U`, `V`)
- 제네릭 파라미터 3개 이상이면 의미 있는 이름 필수
- `extends` 제약 누락으로 `T`가 `unknown`과 동일

```typescript
// ❌ BAD
function merge<T, U, V>(a: T, b: U, c: V): T & U & V { ... }

// ✅ GOOD
function mergeConfigs<TBase extends BaseConfig, TOverride extends Partial<TBase>>(
  base: TBase, override: TOverride
): TBase & TOverride { ... }
```
