# Import & Dead Code & 일관성 & 안티패턴 & 테스트

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 유지보수 심각 장애, 패턴 불일치로 인한 버그 |
| 🟡 WARNING | 가독성 저해, 컨벤션 불일치 |
| 🔵 INFO | 스타일 개선 |

---

## 1-1. Import 정리 🟡

권장 순서: ① React/외부 ② 프로젝트 내부(절대) ③ 상대 경로 ④ `import type` ⑤ 스타일

- 미사용 import
- 동일 모듈 여러 줄 import (합칠 수 있음)
- `import type` 사용 가능한데 일반 import 사용

단, **자동화 도구가 이미 정리할 수 있는 단순 순서 문제만** 보이면 우선순위를 낮게 본다. 리뷰에서는 실제 혼란/오독/unused가 diff에 드러날 때를 우선 지적한다.

## 1-2. Export 일관성 🟡

- named/default export 혼용 → 하나로 통일
- re-export에서 내부 구현 노출
- 한 파일에서 5개+ export → 파일 분할

---

## 2-1. Dead Code 제거 🔴

- 도달 불가 코드 (early return 이후)
- 미사용 변수, 함수, 타입, import
- 주석 처리된 코드 블록 (단, 짧은 실험/A-B 테스트/임시 비활성화는 **이유와 제거 조건**이 있으면 예외 가능)
- 장기간 비활성 Feature flag 코드
- 동일 목적의 이전 구현을 남겨둔 채 새 구현을 추가해, 사실상 하나는 제거 가능한 중복 경로가 됨

## 2-2. 불필요한 래핑 🟡

- 로직 없는 Wrapper 컴포넌트
- 값 그대로 반환 함수 (`const getId = (user) => user.id`)
- 빈 useEffect, 빈 catch 블록

---

## 3-1. 코드 스타일 일관성 🟡

프로젝트 전반 일관성 확인:
- 화살표 함수 vs `function` (컴포넌트 선언)
- 세미콜론, 따옴표, trailing comma, 들여쓰기

## 3-2. 패턴 일관성 🔴

- 같은 성격 컴포넌트가 다른 구조
- 같은 성격 API 호출이 다른 방식 (useQuery vs fetch 혼용)
- 에러 처리 방식 파일마다 상이
- 같은 데이터를 다른 이름으로 참조 (`user`/`userData`/`currentUser`)

```typescript
// ❌ 같은 패턴에 다른 스타일
type UserCardProps = { user: User }
const UserCard = ({ user }: UserCardProps) => { ... }  // 파일 A
interface ProductCardProps { product: Product }
function ProductCard({ product }: ProductCardProps) { ... }  // 파일 B

// ✅ 하나로 통일
interface UserCardProps { user: User }
function UserCard({ user }: UserCardProps) { ... }
```

## 3-3. 에러 처리 일관성 🟡

- API 에러 처리 방식 통일 (toast, 인라인, Error Boundary)
- 에러 메시지 포맷 일관성
- 사용자용 에러 vs 개발자용 에러 구분

---

## 4-1. Negative Condition (부정 조건) 🟡

- 이중 부정 (`!isNotValid`)
- 부정형 변수명 (`notReady`, `disableX`)
- `if (!condition)` 블록이 `else`보다 긴 경우

## 4-2. 과도한 Destructuring 🟡

- 5단+ 중첩 destructuring
- 깊은 destructuring로 원본 구조 파악 불가
- rename 과도하여 원래 키 추적 불가

## 4-3. 암시적 boolean 변환 🟡

- `!!value` → `Boolean(value)` 또는 명시적 비교
- `if (array.length)` 는 순수 스타일 차이만으로 지적하지 않는다. falsy 의미가 여러 값에 걸려 혼동되거나, 숫자 의미를 분명히 해야 할 때만 지적한다
- falsy 값 달라지는 위험한 truthy check

## 4-4. 복잡한 논리 표현식 🟡

- 3개+ 조건이 `&&`/`||`로 연결 → 의미 있는 변수 추출
- 연산자 우선순위 괄호 없이 혼합

```typescript
// ❌
if (user.role === 'admin' || (user.role === 'editor' && user.dept === 'marketing') || user.isSuperUser)

// ✅
const isAdmin = user.role === 'admin'
const isMarketingEditor = user.role === 'editor' && user.dept === 'marketing'
const hasEditAccess = isAdmin || isMarketingEditor || user.isSuperUser
if (hasEditAccess) { ... }
```

---

## 5-1. 테스트 네이밍 🟡

- `test('test1', ...)` 같은 의미 없는 이름
- 기대 동작을 서술하지 않는 이름
- 한국어/영어 혼용 (프로젝트 내 통일)

## 5-2. AAA 패턴 (Arrange-Act-Assert) 🟡

- 준비/실행/검증 단계 분리 여부
- 하나의 테스트에서 여러 행위 검증 → 분리
- 테스트 간 상태 공유로 순서 의존성
