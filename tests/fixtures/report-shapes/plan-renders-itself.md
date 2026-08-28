## 리뷰 기준

- 대상 브랜치: `feature/x`
- base: `main`
- 규칙 디렉터리: `/rules/2.6.2/review-rules`
- 플러그인 버전: `2.6.2`

## 판정

머지 보류. 🔴 1건.

## 실행 계획

- `full-review-results.json`을 읽어 결정적 Markdown 리포트를 생성했습니다.
- 후보 ID는 각 finding heading의 `<규칙 ID>#1` 형식을 사용했습니다.
- 표시 순서는 입력 JSON의 순서를 유지했고, finding heading을 정확히 보존했습니다.

## 상세 지적

### 03 React 규칙

#### 🔴 `03-3` 렌더 중 생성한 값을 key로 쓴다
`src/a.tsx:11` — `<li key={Math.random()}>`

본문: 매 렌더 재마운트가 일어난다.

### 06 JSX

#### 🟡 `06-1` falsy 값이 렌더된다
`src/b.tsx:8` — `{count && <Badge />}`

본문: count가 0이면 0이 화면에 보인다.

## 요약

| 구분 | 🔴 | 🟡 | 🔵 |
|---|---|---|---|
| 합계 | 1 | 1 | 0 |

## 도구 실행 결과

| 도구 | 결과 |
|---|---|
| `npm run lint` | 통과 |

## 미해결 / 후속 확인

없음.
