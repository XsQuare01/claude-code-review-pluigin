# JSX & 렌더링 표현

이 모듈은 **JSX로 작성된 렌더 표현의 정확성과 가독성**을 본다.

다음은 이 문서의 검사 범위가 아니다 (중복 방지):

- key 안정성, 렌더 순수성 → `03-react-rules.md`
- 컴포넌트 크기, 핸들러 추출 → `05-structure.md`
- className 정리, 디자인 토큰 → `11-styling.md`
- 접근성(semantic element, label, ARIA) → `12-accessibility.md`

## Severity 기준

| Severity | 의미 |
|----------|------|
| 🔴 ERROR | 의도하지 않은 렌더 결과가 실제로 나옴 |
| 🟡 WARNING | 가독성 저해, 분리 필요 |
| 🔵 INFO | 더 단순한 표현 가능 |

---

## 06-1. Falsy 값 렌더링 함정 🔴

`&&`의 좌변이 `0`이나 `''`이면 React가 그 값을 **그대로 렌더한다.** 빈 화면을 기대한 자리에 `0`이 찍힌다.

```typescript
// ❌ count가 0이면 화면에 "0"이 렌더됨
{count && <Badge count={count} />}

// ✅ 명시적 boolean
{count > 0 && <Badge count={count} />}
```

- 숫자 state·배열 `length`·문자열을 `&&` 좌변에 그대로 쓰는 경우
- `NaN`이 좌변인 경우 (`NaN &&`는 `NaN`을 렌더)

## 06-2. 조건부 렌더링 가독성 🟡

- 삼항 연산자 2단+ 중첩 → early return 또는 별도 컴포넌트
- 조건부 블록 10줄+ → 별도 컴포넌트로 추출
- 같은 조건이 JSX 여러 곳에 흩어져 분기 전체를 파악하기 어려움
- 3개 이상 분기를 삼항 체인으로 표현 → 맵 기반 또는 컴포넌트 분리

## 06-3. 리스트 렌더링 🟡

- `map` 콜백 10줄+ → 별도 컴포넌트로 추출
- `map` 안에 복잡한 조건부 렌더링이 중첩됨
- `map` 콜백 안에서 hook 호출 (`03-react-rules.md` 03-1 위반)
- 리스트 항목마다 인라인 객체·핸들러를 새로 만들어 memo 자식에 전달

key 선택 규칙은 `03-react-rules.md` 03-3을 따른다.

## 06-4. JSX 가독성 🟡

- Props 4개+ 를 한 줄에 나열 → 멀티라인
- 인라인 함수 5줄+ → 별도 핸들러로 추출
- 인라인 `style` 3속성+ → className (`11-styling.md`)
- 불필요한 Fragment (자식 1개) 또는 불필요한 wrapper `div`
- JSX 중첩 깊이가 5단+ 이고 각 층이 의미를 갖지 않음

## 06-5. Props Spreading 🟡

`{...props}` 무분별 전달. rest props는 HTML 요소에만, 커스텀 컴포넌트에는 명시적 전달.

- 어떤 props가 실제로 내려가는지 호출부에서 추론 불가
- spreading 때문에 DOM에 알 수 없는 속성이 전달되어 경고 발생
- `{...props}` 뒤에 같은 prop을 다시 지정해 덮어쓰기 순서에 의존

## 06-6. 렌더 함수 반환 패턴 🔵

- 컴포넌트를 반환하는 함수를 컴포넌트 본문 안에 정의 → 매 렌더 새 타입이 되어 재마운트. 밖으로 빼거나 직접 JSX로
- render prop과 children이 혼용되어 사용법이 불명확
- 빈 Fragment(`<></>`)를 반환하는 분기가 `null` 반환과 섞여 일관성이 없음
