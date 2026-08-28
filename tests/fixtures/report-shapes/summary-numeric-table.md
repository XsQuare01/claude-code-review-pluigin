## 리뷰 기준

- 대상 브랜치: `feature/x`
- base: `main`
- 규칙 디렉터리: `/rules/2.6.2/review-rules`
- 플러그인 버전: `2.6.2`

## 판정

머지 보류. 🔴 1건.

## 실행 계획

- numbered 후보: `N=20`
- 적용: `M=18`
- `16` `SKIPPED`: API/IPC 계약 변경 없음
- `21` `SKIPPED`: RSC 미사용
- producer 실패: 0건
- verifier 실패: 0건
- malformed-output 실패: 0건

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
