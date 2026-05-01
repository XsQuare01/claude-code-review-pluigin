# 컴포넌트 구조 & JSX & DX

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 유지보수 비용 극단적, 읽을 수 없는 코드 |
| 🟡 WARNING | 가독성 저해, 분리 필요 |
| 🔵 INFO | 더 나은 구조 가능 |

---

## 1-1. 함수 길이 🔴

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

## 1-2. 컴포넌트 크기 🔴

**150줄 초과는 반드시 검토해야 하는 강한 신호다.** 다만 줄 수만으로 자동 위반 처리하지 말고, JSX 인라인 로직 10줄+, useState 5개+, return 이전 로직이 절반+, 독립 UI 영역 3개+처럼 **관심사 혼재가 실제로 보일 때** 지적한다.

## 1-3. Early Return (Guard Clause) 🟡

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

## 1-4. 매개변수 개수 🟡

3개 초과는 객체 파라미터 검토 신호. 다만 좌표/범위처럼 함께 읽히는 값 묶음은 예외 가능. boolean 매개변수 호출부 의미가 불분명하면 객체로.

## 1-5. 단일 추상화 수준 🟡

고수준 호출과 저수준 구현이 혼재하는 경우.

---

## 2-1. 조건부 렌더링 가독성 🔴

- 삼항 연산자 2단+ 중첩
- `&&` 좌변이 `0`/`''`일 수 있어 의도치 않은 렌더링
- 조건부 블록 10줄+ → 별도 컴포넌트

```typescript
// ❌ 0이 렌더링됨
{count && <Badge count={count} />}

// ✅ boolean 변환
{count > 0 && <Badge count={count} />}
```

## 2-2. JSX 가독성 🟡

- Props 4개+ 한 줄 나열 → 멀티라인
- 인라인 함수 5줄+ → 별도 핸들러 검토
- 인라인 스타일 3속성+ → className
- 불필요한 Fragment (자식 1개)

## 2-3. 리스트 렌더링 🟡

- `map` 콜백 10줄+ → 별도 컴포넌트
- key에 배열 인덱스 사용
- `map` 안 복잡한 조건부 렌더링 중첩

## 2-4. Props Spreading 🟡

`{...props}` 무분별 전달. rest props는 HTML 요소에만, 커스텀 컴포넌트에는 명시적 전달.

---

## 3-1. 컴포넌트 크기 & 관심사 분리 🟡

- 300줄 초과 → 분할 제안
- UI + 비즈니스 로직 혼재 → 커스텀 훅 분리
- 독립 책임 3개+ 담당

## 3-2. 중복 코드 & 보일러플레이트 🟡

- 2+ 슬라이스/컴포넌트/훅에 동일 로직 복사 → 공통 훅 또는 shared 추출
- 반복 API 호출/변환/검증 패턴이 여러 파일에 복붙됨
- 불필요하게 장황한 코드

중복 코드를 지적할 때는 가능하면 아래까지 함께 제안한다:
- 어느 구현을 **단일 출처**로 남길지
- 어떤 복사본은 **삭제**해야 하는지
- 공통화보다 삭제/통합이 더 단순한 경우, 추상화보다 **중복 제거와 삭제**를 우선 권장

특히 다음이면 강하게 본다:
- 같은 버그 수정/정책 변경을 여러 복사본에 동시에 반영해야 하는 구조
- 이름만 조금 다르고 실질 로직은 같은 함수/훅/핸들러가 반복됨
- 이전 구현을 남겨둔 채 새 구현을 옆에 추가해 사실상 중복 경로가 생김

## 3-3. Barrel Export & Path Alias 🔵

- barrel export 구조 일관성
- path alias 올바른 설정 및 일관 사용
- 상대/절대 경로 혼용 (슬라이스 간 절대, 내부 상대)

## 3-4. 매직 넘버 & 문자열 🔵

- 의미 불분명 숫자 리터럴 → named constant
- 반복 문자열 리터럴 → 상수 또는 유니온 타입
- API 엔드포인트 하드코딩

## 3-5. 온보딩 & 구조 일관성 🔵

- 같은 레이어 내 segment 구조 불일치
- 린터/포매터 설정과 실제 코드 불일치
- 복잡한 패턴에 주석/문서 부재

## 3-6. 파일당 하나의 컴포넌트 🔴

하나의 파일에 export 컴포넌트 2개+ 금지. 내부 헬퍼 컴포넌트(export 안 함)는 예외.
