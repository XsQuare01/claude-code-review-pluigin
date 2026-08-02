# Import & Dead Code & 일관성

이 모듈은 **모듈 경계 표현, 남은 코드, 프로젝트 내 일관성**을 본다.

다음은 이 문서의 검사 범위가 아니다 (중복 방지):

- 레이어 방향, Public API 경계 위반 → `01-fsd.md`
- 이름 자체의 적절성 → `07-naming.md`
- 실패 흐름의 안전성 → `exception.md` (에러 처리 *방식의 통일*만 여기서 본다)
- 테스트/목 전용 파일 → 리뷰 대상에서 제외 (`00-rule.md`, `20-deletion-regression.md`)

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 유지보수 심각 장애, 패턴 불일치로 인한 버그 |
| 🟡 WARNING | 가독성 저해, 컨벤션 불일치 |
| 🔵 INFO | 스타일 개선 |

---

## 09-1. Import 정리 🟡

권장 순서: ① React/외부 ② 프로젝트 내부(절대) ③ 상대 경로 ④ `import type` ⑤ 스타일

- 미사용 import
- 동일 모듈 여러 줄 import (합칠 수 있음)
- `import type` 사용 가능한데 일반 import 사용

단, **자동화 도구가 이미 정리할 수 있는 단순 순서 문제만** 보이면 우선순위를 낮게 본다. 리뷰에서는 실제 혼란/오독/unused가 diff에 드러날 때를 우선 지적한다.

## 09-2. Export 일관성 🟡

- named/default export 혼용 → 하나로 통일
- re-export에서 내부 구현 노출
- 한 파일에서 5개+ export → 파일 분할

## 09-3. Barrel Export & Path Alias 🔵

- barrel export 구조 일관성
- path alias 올바른 설정 및 일관 사용
- 상대/절대 경로 혼용 (슬라이스 간 절대, 내부 상대)

FSD 프로젝트에서 barrel이 Public API 경계 역할을 하면 `01-fsd.md`가 우선한다.

---

## 09-4. Dead Code 제거 🔴

- 도달 불가 코드 (early return 이후)
- 미사용 변수, 함수, 타입, import
- 주석 처리된 코드 블록 (단, 짧은 실험/A-B 테스트/임시 비활성화는 **이유와 제거 조건**이 있으면 예외 가능)
- 장기간 비활성 Feature flag 코드
- 동일 목적의 이전 구현을 남겨둔 채 새 구현을 추가해, 사실상 하나는 제거 가능한 중복 경로가 됨

## 09-5. 불필요한 래핑 🟡

- 로직 없는 Wrapper 컴포넌트
- 값 그대로 반환 함수 (`const getId = (user) => user.id`)
- 빈 `useEffect`, 빈 `catch` 블록

## 09-6. Fast Refresh 규칙 우회 🔴

- `// eslint-disable-next-line react-refresh/only-export-components` 또는 동등한 suppression으로 Fast Refresh 규칙을 우회하면 위반
- 컴포넌트 파일에서 컴포넌트가 아닌 값/상수/헬퍼를 함께 export하려고 lint를 끈 경우, 파일 분리 또는 export 구조 정리를 요구
- 정당한 이유 없이 suppression만 추가한 경우는 리뷰 우회로 본다
- 예외는 라이브러리 제약이나 마이그레이션 중 임시 조치처럼 이유와 제거 조건이 diff 안에 명확한 경우만 허용

---

## 09-7. 코드 스타일 일관성 🟡

프로젝트 전반 일관성 확인:

- 화살표 함수 vs `function` (컴포넌트 선언)
- 세미콜론, 따옴표, trailing comma, 들여쓰기

## 09-8. 패턴 일관성 🔴

- 같은 성격 컴포넌트가 다른 구조
- 같은 성격 API 호출이 다른 방식 (useQuery vs fetch 혼용)
- 에러 처리 방식이 파일마다 상이

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

## 09-9. 에러 처리 방식의 통일 🟡

- API 에러 표시 표면 통일 (toast, 인라인, Error Boundary)
- 에러 메시지 포맷 일관성
- 사용자용 에러 vs 개발자용 에러 구분

실패가 **삼켜지거나 잘못 전파되는지**는 `exception.md`가 우선한다. 이 규칙은 표현 방식의 통일만 본다.

---

## 09-10. Negative Condition 🟡

- 이중 부정 (`!isNotValid`)
- 부정형 변수명 (`notReady`, `disableX`)
- `if (!condition)` 블록이 `else`보다 긴 경우

## 09-11. 과도한 Destructuring 🟡

- 5단+ 중첩 destructuring
- 깊은 destructuring으로 원본 구조 파악 불가
- rename 과도하여 원래 키 추적 불가

## 09-12. 암시적 boolean 변환 🟡

- `!!value` → `Boolean(value)` 또는 명시적 비교
- `if (array.length)` 는 순수 스타일 차이만으로 지적하지 않는다. falsy 의미가 여러 값에 걸쳐 혼동되거나, 숫자 의미를 분명히 해야 할 때만 지적한다
- falsy 값이 달라지는 위험한 truthy check

JSX 안의 `&&` falsy 렌더링 함정은 `06-jsx.md` 06-1이 우선한다.

## 09-13. 복잡한 논리 표현식 🟡

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
