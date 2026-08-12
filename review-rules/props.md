# Props Drilling & Argument Passing Review Rules

Props drilling, 과도한 props 전달, 함수 인자 과다를 독립적으로 검토하는 전용 리뷰 문서. `/code-review-props`와 `/code-review-full`의 Props 패스에서만 사용된다. 파일명에 숫자 prefix가 없으므로 일반 `/code-review` 자동 모듈 스캔에서 제외된다.

**규칙 ID는 `P-{번호}` 형식으로 표기한다.**

검사 범위:

- React 컴포넌트 props 전달 구조
- 함수/훅/서비스/API 호출의 인자 개수와 호출부 가독성
- 중간 컴포넌트가 데이터나 핸들러를 단순 전달만 하는 구조
- props 묶음, context/store, composition, colocation으로 단순화 가능한 흐름

## Severity

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 전달 구조 때문에 하위 컴포넌트가 상위 구현에 강결합되어 수정 비용·버그 위험이 큼 |
| 🟡 WARNING | 가독성/유지보수성 저하, 구조 단순화 권장 |
| 🔵 INFO | 더 명확한 API나 전달 방식 제안 |

`04-state.md`는 상태를 **어디에 두었는지**를 보고, 이 문서는 그 값이 **어떻게 전달되는지**를 본다. 같은 코드에 둘 다 해당하면 전달 구조 쪽은 이 문서의 P-x로 지적한다.

---

## P-1. Props drilling 3단계 이상 🟡

부모 → 중간 → 하위로 같은 값이 3단계 이상 전달되며, 중간 컴포넌트가 그 값을 직접 사용하지 않으면 위반 후보.

지적 기준:

- 중간 컴포넌트가 props를 받자마자 자식에게 그대로 넘김
- 동일 props 이름 또는 동일 의미의 alias가 여러 컴포넌트를 통과
- 특정 leaf 컴포넌트 전용 상태가 상위 페이지/위젯까지 끌어올려짐
- 한 변경에 여러 중간 컴포넌트의 props 정의를 같이 수정해야 함

단, 모든 drilling이 위반은 아니다. 아래면 지적하지 않는다:

- 1~2단계 전달이고 구조가 단순함
- 화면 로컬 상태라서 Context/전역 상태가 오히려 과함
- drilling 제거보다 명시적 전달이 더 읽기 쉬움

개선 방향:

- 실제 사용 위치 가까이 state colocate
- 관련 하위 트리를 합성 컴포넌트(children/slot)로 묶기
- 여러 leaf에서 공유해야 하면 context/store 검토 (P-6 함께 확인)
- feature/entity public API나 custom hook으로 데이터 접근 경계 정리

## P-2. Pass-through component 🟡

컴포넌트가 의미 있는 렌더링·조합·도메인 책임 없이 props 전달만 담당하면 위반 후보.

지적 기준:

- 컴포넌트 본문 대부분이 `<Child {...props} />` 또는 동일 props 재전달
- wrapper가 스타일/레이아웃/접근성/상태 책임 없이 계층만 늘림
- 기존 컴포넌트를 감싸지만 API를 단순 복제해 발견성과 수정 비용만 증가

개선 방향:

- wrapper 제거 후 직접 사용
- wrapper가 필요하면 명확한 책임(레이아웃, 접근성, 정책)을 갖게 분리
- children/render prop/composition으로 전달 경로 단축

## P-3. Props 개수 과다 🟡

하나의 컴포넌트에 props가 7개 이상 전달되면 구조 검토 신호다. 단순 UI primitive처럼 명확한 예외는 맥락으로 판단한다.

강하게 지적할 조건:

- boolean props 3개 이상으로 렌더링 모드가 조합 폭발
- 같은 도메인의 값들이 낱개 props로 흩어짐 (`userName`, `userEmail`, `userRole` 등)
- 데이터 props와 action props가 섞여 컴포넌트 책임이 불명확
- 호출부마다 props 조합이 달라 사용법을 추론해야 함

개선 방향:

- 응집도 높은 객체 props로 묶기 (`user`, `pagination`, `filters`)
- variant/discriminated union으로 모드 표현
- container/presenter 분리 또는 custom hook으로 상태·액션 묶기

## P-4. 함수 인자 4개 초과 🟡

함수·훅·서비스 호출에서 인자 4개 이상은 객체 파라미터 검토 신호다. 좌표나 범위처럼 함께 읽히는 짧은 값 묶음은 예외 가능.

강하게 지적할 조건:

- boolean 인자가 포함되어 호출부 의미가 불분명 (`save(user, true, false)`)
- optional 인자 때문에 `undefined` placeholder가 등장
- 동일 인자 묶음이 여러 호출부에서 반복
- 인자 순서 실수 가능성이 높고 타입만으로 의미가 드러나지 않음

개선 방향:

- named object parameter로 전환
- 옵션과 필수 입력 분리
- 명령형 함수는 command object 또는 DTO로 묶기

## P-5. 핸들러·setter 전달 과다 🔴

상위 상태 setter나 도메인 mutation 핸들러가 여러 단계 아래로 전달되어 **leaf가 상위 상태 구조를 알아야 하면** 위반. P-1과 달리 이건 결합 방향의 문제라 🔴이다.

지적 기준:

- `setState`, `dispatch`, mutation trigger가 UI leaf까지 직접 전달
- leaf 컴포넌트가 상위 상태 shape에 맞춰 값을 조립
- 여러 handler가 한 컴포넌트에 뭉쳐 사실상 controller 역할을 함

개선 방향:

- leaf에는 의도 중심 콜백만 노출 (`onSubmit`, `onSelectUser`)
- 상태 변경 로직은 custom hook/feature action에 숨김
- 여러 handler가 같은 use case라면 하나의 action API로 묶기

## P-6. Context/store 남용 예외 체크 🟡

props drilling 해결책으로 context/store를 제안할 때도 남용 여부를 함께 본다.

지적 기준:

- 한두 단계 전달이면 단순 props가 더 명확한데 전역 store로 이동
- 특정 화면 전용 상태를 app-wide context에 올림
- provider value가 매 렌더 새 객체인데 memoization 없음 (`04-state.md` 04-6)
- context가 데이터·액션·UI 상태를 모두 담아 변경 영향이 과도함

개선 방향:

- 먼저 colocation/composition으로 해결 가능한지 검토
- context는 실제로 같은 하위 트리 여러 곳에서 필요한 값에 한정
- value 분리 또는 selector 기반 store 사용

---

## 출력 형식

| Severity | 영향·확신 | 파일 | 위치 | 규칙 | 이슈 | 개선 방향 |
|----------|-----------|------|------|------|------|----------|
| 🔴/🟡/🔵 | 낮음·높음 | path/to/file | line | P-x | 구체적 전달 구조 문제 | 단순화 방향 |

- `영향·확신` 열에는 두 축의 값을 `·`로 이어 적는다. 근거가 필요한 쪽은 값 뒤 괄호에 함께 적는다 — `낮음·높음`, `높음(데이터 손상)·높음`, `낮음·낮음(부모 미확인)`.
- **`Severity` 열은 이 열에서 파생한 계산값이다** (`00-rule.md`의 **Severity 기준**). 두 축을 먼저 판정하고 파생표대로 이모지를 적는다. 두 축과 어긋난 이모지는 그 자체가 오류다.
- 두 축은 **이 패스가 판정한다.** 코드를 읽은 것이 이 패스이므로, 오케스트레이터가 나중에 채워 넣을 수 없다.

**원칙**

- diff에 포함된 변경 라인 또는 그 변경 때문에 직접 생긴 인접 구조만 지적한다.
- 실제 호출 체인과 컴포넌트 트리를 읽고 판단한다. props 이름만 보고 추측하지 않는다.
- 단순히 props 개수만 세지 말고, 중간 전달·책임 혼재·호출부 의미 불명확성까지 함께 설명한다.
- 이슈가 없으면 `위반 없음`만 출력한다.
