# 함수 & 컴포넌트 구조

이 모듈은 **한 단위(함수·컴포넌트·훅)가 얼마나 많은 일을 떠안고 있는지**를 본다.

다음은 이 문서의 검사 범위가 아니다 (중복 방지):

- JSX 표현, 조건부 렌더링, 리스트 렌더링 → `06-jsx.md`
- 발견성, 파일 위치, 온보딩 비용 → `13-dx.md`
- 매직 넘버·문자열, 상수 위치 → `08-constants.md`
- barrel export, path alias, import 정리 → `09-code-quality.md`

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 관심사가 뒤엉켜 읽기·수정 비용이 극단적으로 큼 |
| 🟡 WARNING | 가독성 저해, 분리 필요 |
| 🔵 INFO | 더 나은 구조 가능 |

---

## 05-1. 함수 길이 🔴

**20줄 초과는 분할 검토 신호다.** 줄 수 자체보다 여러 추상화 수준 혼재, 중첩 조건 3단+, 독립 작업 3개+ 순차 수행처럼 **읽기 비용이 실제로 커지는지**를 우선 본다.

```typescript
// ❌ 하나에 모든 것
async function handleSubmit(formData: FormData) {
  // 유효성 검증 5줄 + 변환 8줄 + API 호출 10줄 + 후처리 5줄
}

// ✅ 추상화 수준별 분리
async function handleSubmit(formData: FormData) {
  const errors = validateUserForm(formData)
  if (errors.length > 0) return showValidationErrors(errors)
  const payload = toCreateUserPayload(formData)
  const result = await createUser(payload)
  if (result.success) onSubmitSuccess()
  else onSubmitError(result.error)
}
```

## 05-2. 컴포넌트 크기 🔴

임계값은 **150줄 하나로 통일한다.** 150줄 초과는 반드시 검토해야 하는 강한 신호이며, 줄 수만으로 자동 위반 처리하지 않는다. 아래처럼 **관심사 혼재가 실제로 보일 때** 지적한다.

- JSX 인라인 로직 10줄+
- `useState` 5개+ 또는 훅 호출이 화면 절반을 차지
- return 이전 로직이 파일 절반+
- 독립 UI 영역 3개+ 가 한 컴포넌트에 있음
- UI 렌더링과 비즈니스 로직이 같은 함수에 섞임 → 커스텀 훅 분리

150줄을 크게 넘고(예: 300줄+) 위 신호까지 겹치면 분할을 강하게 요구한다.

## 05-3. Early Return (Guard Clause) 🟡

if-else 중첩 2단+ → early return으로 평탄화.

```typescript
// ❌ 깊은 중첩
if (order) { if (order.items.length > 0) { if (order.payment) { ... } } }

// ✅ Early return
if (!order) return { error: '주문 없음' }
if (order.items.length === 0) return { error: '빈 주문' }
if (!order.payment) return { error: '결제 정보 없음' }
return submitOrder(order)
```

컴포넌트에서 early return을 쓸 때는 **모든 hook 호출이 그 앞에 있어야 한다** (`03-react-rules.md` 03-1).

## 05-4. 매개변수 개수 🟡

3개 초과는 객체 파라미터 검토 신호. 다만 좌표/범위처럼 함께 읽히는 값 묶음은 예외 가능. boolean 매개변수 호출부 의미가 불분명하면 객체로.

컴포넌트 props 개수와 전달 구조 자체는 `/code-review-props`의 `props.md`가 더 구체적으로 다룬다.

## 05-5. 단일 추상화 수준 🟡

고수준 호출과 저수준 구현이 한 함수에 혼재하는 경우.

## 05-6. 관심사 분리 🟡

- 컴포넌트가 데이터 페칭 + 비즈니스 로직 + 렌더링을 모두 담당
- 커스텀 훅이 서로 무관한 여러 상태를 함께 관리
- 훅이 10개 이상 값을 반환 → 분할 필요
- 훅 이름에서 역할 유추 불가 (`useData`, `useStuff`)

## 05-7. 중복 코드 🟡

- 2+ 컴포넌트/훅/슬라이스에 동일 로직 복사 → 공통 훅 또는 shared 추출
- 반복 API 호출/변환/검증 패턴이 여러 파일에 복붙됨

중복 코드를 지적할 때는 가능하면 아래까지 함께 제안한다:

- 어느 구현을 **단일 출처**로 남길지
- 어떤 복사본은 **삭제**해야 하는지
- 공통화보다 삭제/통합이 더 단순한 경우, 추상화보다 **중복 제거와 삭제**를 우선 권장

특히 다음이면 강하게 본다:

- 같은 버그 수정/정책 변경을 여러 복사본에 동시에 반영해야 하는 구조
- 이름만 조금 다르고 실질 로직은 같은 함수/훅/핸들러가 반복됨
- 이전 구현을 남겨둔 채 새 구현을 옆에 추가해 사실상 중복 경로가 생김

## 05-8. 파일당 하나의 컴포넌트 🔴

하나의 파일에 export 컴포넌트 2개+ 금지. 내부 헬퍼 컴포넌트(export 안 함)는 예외.

## 05-9. 이벤트 핸들러 구조 🟡

- 핸들러 내부 5줄 초과 → 별도 함수 추출
- 인라인 핸들러에 로직 포함
- 여러 핸들러가 한 컴포넌트에 뭉쳐 사실상 controller 역할을 함

핸들러 **네이밍**(`handle`/`on` 접두어)은 `07-naming.md`가 다룬다.
