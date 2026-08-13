# 네이밍 & 주석

이 모듈은 **이름과 주석이 의도를 정확히 전달하는지**를 본다. 상수 추출과 상수 위치는 `08-constants.md`가 다룬다.

## 영향도 보정 예시

| 영향도 | 이 모듈에서 자주 보이는 근거 |
|----------|------|
| 높음 | 이름 혼란이 실제 잘못된 사용, 잘못된 분기, 검증 실패로 이어지는 경우 |
| 낮음 | 가독성, 컨벤션, 설명 명확성 중심 문제에 머무는 경우 |

---

## 07-1. 변수 & 함수 네이밍 🔴

- 약어/한 글자 변수 (`d`, `temp`, `val` — 루프 `i` 제외)
- 모호한 이름 (`data`, `info`, `item`, `stuff`) — 단, `Result<T, E>` 같은 표준 결과 타입/패턴 문맥의 `result`는 예외 가능
- 지나치게 긴 이름 — 조건, 구현 세부사항, 비즈니스 문맥을 한 식별자에 과도하게 합쳐 사람이 훑어 읽거나 발음하기 어려움. 단, 구체적인 이름 자체는 권장하며, 짧게 줄이기보다 책임 분리나 중간 개념 추출로 스캔하기 쉽게 만든다
- 동사 없는 함수명
- boolean에 `is/has/should/can` 접두어 없음 — 단, 플랫폼/HTML 표준 속성과 맞춘 `disabled`, `checked`, `selected`, `required`, `readOnly`, `open` 같은 이름은 예외 가능

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

## 07-2. 핸들러 & 콜백 네이밍 🔴

- 핸들러 함수에 `handle` 접두어 없음 (`handleSubmit`, `handleSelectUser`)
- 이벤트 콜백 Props에 `on` 접두어 없음 (`onSubmit`, `onSelectUser`)
- 콜백 이름이 구현("어떻게")을 드러내고 의도("무엇")를 감춤 (`onSetIsOpenTrue` → `onOpen`)

## 07-3. 컴포넌트 네이밍 🟡

- 이름이 렌더링 내용을 설명하지 않음
- 일반적 이름 단독 사용 (`Container`, `Wrapper`, `Component`)
- 파일명과 컴포넌트명 불일치
- 부적절한 접미어 (`Manager`, `Processor`)

## 07-4. 훅 네이밍 🟡

- 커스텀 훅이 `use` 접두어를 쓰지 않음 (Hooks 규칙 검사에서도 누락됨 → `03-react-rules.md` 03-1)
- `use` 접두어인데 hook을 전혀 호출하지 않는 일반 함수
- 훅 이름에서 반환값의 성격(상태/액션/조회)이 드러나지 않음

## 07-5. 타입 & 인터페이스 네이밍 🟡

- `I` 접두어 사용 일관성 (사용 또는 미사용 통일). 특별한 팀 합의가 없다면 **no `I` prefix** 쪽을 권장
- Props 타입이 `{ComponentName}Props` 패턴 안 따름
- 유니온 타입 멤버 대소문자 불일치

## 07-6. 파일 & 디렉토리 네이밍 🟡

- 컴포넌트: PascalCase, 훅: camelCase+use, 유틸: camelCase
- 프로젝트 내 PascalCase + kebab-case 혼재

## 07-7. 개념 일관성 🔴

같은 데이터를 파일마다 다른 이름으로 부르면 위반 (`user` / `userData` / `currentUser` 혼용). 어느 이름을 표준으로 삼을지 함께 제안한다.

---

## 07-8. 불필요한 주석 🟡

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

## 07-9. 필수 주석 🟡

**반드시** 주석이 있어야 하는 경우:

- 비자명한 비즈니스 규칙
- 복잡한 정규표현식
- Workaround / 임시 해결책 (이유 + 제거 시점)
- 의도적 비표준 패턴
- 의도적으로 React 기본 동작에서 벗어난 처리 (예: 리셋 목적의 `key`, 의도적 `exhaustive-deps` suppression)

## 07-OUTPUT. 도메인 결과 가이드

- 네이밍 지적은 **무엇을 오해하게 만드는지**를 적는다. 단순히 마음에 안 드는 이름이 아니라, 호출부나 후속 변경에서 어떤 혼동을 부르는지가 보여야 한다.
- 같은 개념의 이름이 갈라졌다면 어느 이름을 표준으로 삼을지 제안해, 수정 방향이 즉시 보이게 한다.
- 주석은 "있다/없다"보다 **왜 설명이 필요한 자리인지, 지금 주석이 왜 거짓이거나 불충분한지**를 남긴다.
