# 네이밍 & 주석 & 상수

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 의도 파악 불가, 유지보수 심각한 장애 |
| 🟡 WARNING | 가독성 저해, 컨벤션 불일치 |
| 🔵 INFO | 더 명확한 대안 가능 |

---

## 1-1. 변수 & 함수 네이밍 🔴

- 약어/한 글자 변수 (`d`, `temp`, `val` — 루프 `i` 제외)
- 모호한 이름 (`data`, `info`, `item`, `stuff`) — 단, `Result<T, E>` 같은 표준 결과 타입/패턴 문맥의 `result`는 예외 가능
- 지나치게 긴 이름 — 조건, 구현 세부사항, 비즈니스 문맥을 한 식별자에 과도하게 합쳐 사람이 훑어 읽거나 발음하기 어려움. 단, 구체적인 이름 자체는 권장하며, 짧게 줄이기보다 책임 분리나 중간 개념 추출로 스캔하기 쉽게 만든다
- 동사 없는 함수명
- boolean에 `is/has/should/can` 접두어 없음 — 단, 플랫폼/HTML 표준 속성과 맞춘 `disabled`, `checked`, `selected`, `required`, `readOnly`, `open` 같은 이름은 예외 가능
- 핸들러에 `handle` 접두어 없음

```typescript
// ❌
const d = new Date()
const [open, setOpen] = useState(false)
const shouldShowPaymentRetryButtonWhenUserHasExpiredCardAndCheckoutSessionIsRecoverable = true

// ✅
const createdAt = new Date()
const [isOpen, setIsOpen] = useState(false)
const canRetryPayment = hasExpiredCard && isCheckoutRecoverable
```

## 1-2. 컴포넌트 네이밍 🟡

- 이름이 렌더링 내용을 설명 안 함
- 일반적 이름 단독 사용 (`Container`, `Wrapper`, `Component`)
- 파일명과 컴포넌트명 불일치
- 부적절한 접미어 (`Manager`, `Processor`)

## 1-3. 타입 & 인터페이스 네이밍 🟡

- `I` 접두어 사용 일관성 (사용 또는 미사용 통일). 특별한 팀 합의가 없다면 **no `I` prefix** 쪽을 권장
- Props 타입이 `{ComponentName}Props` 패턴 안 따름
- 유니온 타입 멤버 대소문자 불일치

## 1-4. 파일 & 디렉토리 네이밍 🟡

- 컴포넌트: PascalCase, 훅: camelCase+use, 유틸: camelCase
- 프로젝트 내 PascalCase + kebab-case 혼재

---

## 2-1. 불필요한 주석 🟡

- 코드가 이미 설명하는 내용 반복 (`// 이메일 검사` + `validateEmail()`)
- 주석 처리된 코드 (git이 이력 관리)
- 코드와 불일치하는 오래된 주석
- 이슈 트래커 미연결 TODO/FIXME

```typescript
// ❌ 코드 반복
// 사용자 목록을 가져온다
const users = await fetchUsers()

// ✅ "왜"를 설명
// Safari에서 position: sticky가 overflow: hidden 내에서 작동 안 하여 workaround
const containerStyle = { overflow: 'auto' }
```

## 2-2. 필수 주석 🟡

**반드시** 주석이 있어야 하는 경우:
- 비자명한 비즈니스 규칙
- 복잡한 정규표현식
- Workaround / 임시 해결책 (이유 + 제거 시점)
- 의도적 비표준 패턴

---

## 3-1. 매직 넘버 🔴

- 의미 불분명 숫자 리터럴 → named constant
- 타임아웃, 재시도, 페이지 크기 인라인 하드코딩
- 동일 값 여러 곳에 흩어짐

```typescript
// ❌
setTimeout(callback, 3000)
if (retryCount > 3) throw new Error('Failed')

// ✅
const TOAST_DURATION_MS = 3000
const MAX_RETRY_COUNT = 3
```

## 3-2. 매직 문자열 🟡

- API 엔드포인트, 라우트, localStorage 키가 문자열 리터럴로 산재
- 상태값을 문자열 비교 → 유니온 타입 또는 enum
- 사용자에게 직접 노출되는 문구(UI 라벨, 버튼 텍스트, placeholder, tooltip, toast, dialog 메시지, empty state 문구)를 코드에 하드코딩

사용자 노출 문자열을 지적할 때는 가능하면 아래 방향으로 제안한다:

- 단순 상수 추출보다 **i18n 적용**을 우선 권장
- 번역 키/메시지 카탈로그/locale 파일로 이동
- 테스트용/임시 디버그 문구가 아니라면, 제품 표면의 문자열은 지역화 가능한 구조로 정리

단, 아래는 예외 가능:

- 로그 전용 문자열
- 개발자 전용 에러 문구
- 테스트 코드 내부 문자열
- protocol / key / route / enum-like 상태값처럼 번역 대상이 아닌 식별자 문자열

## 3-3. 상수 중복 정의 (상수 산재) 🔴

**동일 값 상수가 여러 파일에 각각 정의.** 매직값 → 상수 추출만으로는 부족. 단일 출처에서 관리되어야 함.

**상수의 위치는 `lib/constants.ts`로 고정한다.** 신규/변경 상수가 다른 파일이나 폴더에 선언되면 단일 출처 규칙 위반으로 지적한다.

- 동일 상수값 2+ 파일에서 선언
- `lib/constants.ts` 외 위치에 상수 선언 또는 상수 전용 파일 추가
- z-index, breakpoint, spacing 컴포넌트마다 개별 정의
- API 엔드포인트, 유효성 상수, 에러 메시지 중복
- localStorage 키, Query Key 여러 곳에 문자열 반복
- 설정값(타임아웃, 페이지 크기) 사용처마다 개별 선언

```typescript
// ❌ Query Key 산재
useQuery({ queryKey: ['user', userId], ... })  // 파일 A
useQuery({ queryKey: ['user', userId], ... })  // 파일 B
queryClient.invalidateQueries({ queryKey: ['user'] })  // 오타 시 무효화 실패

// ✅ 단일 출처
// shared/config/query-keys.ts
export const queryKeys = {
  user: (userId: string) => ['user', userId] as const,
} as const
```

**발견법**: 프로젝트 전체에서 동일 값 `const` 선언 검색. 2곳+ 정의 → 통합 제안.
