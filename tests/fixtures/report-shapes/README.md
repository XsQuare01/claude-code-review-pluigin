# 리포트 레이아웃 fixture

실물 리포트가 쓰는 **레이아웃**만 뽑은 합성 fixture다. 사용자 프로젝트의
코드 경로나 내용은 들어 있지 않다 — 테스트에 필요한 것은 형태이지 그
프로젝트가 아니다.

## 왜 필요한가

A2 기준선에서 `summaryArithmetic`이 `2회 중 2회 OK`였다. **fixture 리포트가
우연히 한 형식만 썼기 때문**이다. 2.6.2로 돌린 실사용 리포트 두 건에서 처음
갈렸다 — 하나는 산술이 맞는데 불일치로 판정됐고, 하나는 계약 위반을 담고도
`skeletonOk: true`를 받았다.

계측기가 자기 fixture에만 맞춰지는 것을 막으려면, fixture가 실물이 내는
형식을 전부 담아야 한다.

## 무엇이 다른가

| 파일 | 변수 |
|---|---|
| `summary-numeric-table.md` | 요약이 숫자 열 표 (A2 fixture가 쓰던 형식) |
| `summary-per-finding-table.md` | 요약이 finding별 표 + 산문 총계 (실물 형식) |
| `summary-no-counts.md` | 요약에 severity 집계가 없음 (실물 형식) |
| `plan-contract-shaped.md` | 실행 계획이 후보/적용/SKIPPED/실패 건수를 담음 |
| `plan-renders-itself.md` | 실행 계획이 렌더링 절차를 설명함 (실물 형식) |

나머지 섹션은 전부 같다. **한 번에 한 변수만 바뀐다** — 그래야 채점기 결과의
차이가 무엇에서 왔는지 말할 수 있다.
