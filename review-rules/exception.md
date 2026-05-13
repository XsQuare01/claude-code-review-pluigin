# 예외 처리 검증

이 모듈은 diff 안에서 새로 추가되거나 변경된 예외 처리, 에러 전파, fallback, 복구 흐름을 점검한다. 단순 스타일 통일은 `06-code-quality.md`를 우선하고, 여기서는 **실제 실패 상황에서 안전하게 동작하는지**를 본다.

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 예외가 삼켜지거나 잘못 전파되어 런타임 장애, 데이터 손상, 사용자 플로우 중단 가능 |
| 🟡 WARNING | 실패 처리는 있으나 복구/보고/사용자 안내/개발자 진단 정보가 부족 |
| 🔵 INFO | 더 명확한 에러 모델이나 fallback 구조 제안 |

---

## 1-1. 예외 삼킴과 무음 실패 🔴

- 빈 `catch`, 단순 `console.error`, `return null`, `return undefined`로 실패를 숨기면 위반
- 실패 후 호출자가 성공으로 오해할 수 있는 값(`[]`, `{}`, 기본값)을 반환하면 위반 후보
- 에러를 잡은 뒤 사용자 안내, 상태 업데이트, 재시도, 상위 전파 중 아무 것도 하지 않으면 위반

```typescript
// ❌ 실패를 숨김
try {
  await saveUser(input)
} catch (error) {
  console.error(error)
}

// ✅ 실패를 상태/호출자/사용자 흐름에 반영
try {
  await saveUser(input)
} catch (error) {
  reportError(error)
  setSubmitError(toUserMessage(error))
  throw error
}
```

## 1-2. 에러 전파 계약 🔴

- 함수가 throw 하는지, `Result`/`Either`를 반환하는지, UI 상태로 흡수하는지 계약이 모호하면 위반
- 같은 계층에서 어떤 함수는 throw, 어떤 함수는 `{ error }`, 어떤 함수는 `null`을 반환하면 호출부가 실패를 놓치기 쉽다
- public API, hook, service 함수는 실패 형태가 타입/이름/문서/호출부에서 드러나야 한다
- `catch` 후 다른 에러로 감쌀 때 원인(`cause`)이나 원본 context를 잃으면 위반 후보

## 1-3. 비동기/이벤트 핸들러 실패 처리 🔴

- async 이벤트 핸들러, effect, timeout, subscription, IPC/API callback에서 발생한 에러가 Error Boundary로 자동 전파된다고 가정하면 위반
- promise rejection을 `void fn()`이나 fire-and-forget로 호출하면서 실패 처리 경로가 없으면 위반
- 요청 취소/언마운트/경쟁 조건에서 abort 에러와 실제 실패를 구분하지 않으면 위반 후보
- 재시도 가능한 실패와 즉시 중단해야 하는 실패를 같은 방식으로 처리하면 위험도를 높게 본다

## 1-4. 사용자 안내와 개발자 진단 구분 🟡

- 사용자에게 내부 에러 메시지, stack trace, API 원문을 그대로 노출하면 위반
- 개발자에게 필요한 원인, 요청 context, 식별자가 로깅/리포팅되지 않으면 진단성이 부족함
- toast/inline/Error Boundary/fallback 중 어떤 표면에 보여줄지 프로젝트 패턴과 맞는지 확인
- 민감정보(token, password, personal data)를 에러 메시지나 로그에 포함하면 🔴 ERROR

## 1-5. fallback과 복구 가능성 🟡

- fallback UI가 있다면 사용자가 다시 시도하거나 안전하게 나갈 수 있어야 한다
- 실패 상태에서 로딩이 계속 유지되거나 버튼이 영구 disabled 되면 위반
- 부분 실패를 전체 실패처럼 처리하거나, 전체 실패를 부분 성공처럼 보여주면 위반 후보
- 캐시/낙관적 업데이트/임시 저장을 사용하는 경우 실패 시 rollback 또는 재동기화 경로가 필요하다

## 1-6. 입력·응답 검증 🔴

- 외부 입력(API 응답, IPC, localStorage, URL param, 파일/clipboard)을 검증 없이 신뢰하면 위반 후보
- `JSON.parse`, 날짜/숫자 변환, enum 매핑처럼 실패 가능한 변환에는 실패 경로가 있어야 한다
- schema가 있으면 검증 실패 시 어떤 fallback/에러를 쓰는지 확인한다

---

## 2-1. 리뷰 수행 방법

- `try/catch`, `.catch`, `throw`, `Promise`, `async`, `Error`, `Result`, `fallback`, `toast`, `Error Boundary`가 diff에 추가/변경된 부분을 우선 본다
- 전체 파일을 읽는 것은 context 파악용이며, 지적은 diff 라인 또는 그 변경 때문에 직접 깨진 인접 구조로 제한한다
- 단순히 “에러 처리가 없다”가 아니라, 어떤 실패가 어디서 사라지고 누가 잘못된 성공으로 해석하는지 설명한다
- 프로젝트가 이미 Result 패턴, toast 패턴, Error Boundary 패턴을 갖고 있으면 그 패턴과의 불일치를 함께 본다

## 2-2. 출력 형식

- 실행 가능한 이슈만 출력한다
- 각 지적은 아래 정보를 포함한다
  - 실패 시나리오
  - 현재 처리 방식
  - 왜 위험한지
  - 권장 전파/복구/사용자 안내 방식

## 2-3. 중복 방지

- 단순 에러 메시지 문구 일관성은 `06-code-quality.md`의 에러 처리 일관성 규칙을 우선한다
- 상태 race/abort 문제는 `03-state.md`가 더 직접적으로 다루면 그쪽 판단을 우선한다
- 원칙 이름만 붙이는 지적은 `07-principles.md`에 맡기고, 이 모듈은 실제 실패 흐름을 구체적으로 설명한다
