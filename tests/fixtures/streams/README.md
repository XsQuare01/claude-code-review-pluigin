# stream-json fixture

`claude -p --output-format stream-json`이 stdout에 흘리는 NDJSON의 **형태**만
뽑은 합성 fixture다. 실제 실행에서 받아온 것이 아니고, 사용자 프로젝트의
코드나 리뷰 내용은 들어 있지 않다.

## 왜 필요한가

2026-08-31 `render-throughput` run은 타임아웃을 **재현하는 데는 성공**했다 —
`completed=timeout`, `durationSec=2400`, `reportFound=false`. 그런데 원인을
가르지 못했다:

    opFailures : null
    numTurns   : undefined
    stopReason : undefined

이 값들은 전부 `--output-format json`이 프로세스가 **정상 종료할 때만** 뱉는
결과 봉투에서 나온다. harness가 40분에 kill했으니 봉투를 쓸 기회가 없었다.

> **타임아웃을 재는 데 성공한 순간 진단 정보를 잃는다.**

그래서 `case.json`에 실행 **전에** 등록해 둔 판별 규칙 — "producer가 전부
끝났는데 리포트가 없으면 병목은 렌더 단계다" — 를 적용할 값이 없었다.

stream-json은 턴이 끝날 때마다 한 줄씩 흘린다. 그 줄들을 파일로 받아두면
kill돼도 죽기 직전까지가 남고, 판별을 실제 값으로 할 수 있다.

**이 fixture들은 그 판별을 리뷰 실행 없이 고정한다.** 리뷰 실행은 사용자
지시로 금지돼 있다(`evals/README.md`의 "돌리지 않는다" 절).

## 무엇이 다른가

| 파일 | 재현하는 상황 | 기대 판정 |
|---|---|---|
| `render-stall.ndjson` | producer 3개 전부 반환, `Write` 시작 후 멈춤 | `render` |
| `fanout-stall.ndjson` | producer 3개 중 1개만 반환 | `fanout` |
| `completed.ndjson` | 완주 — 마지막 `result` 이벤트에 봉투가 있다 | 판정 안 함 |
| `no-dispatch.ndjson` | `Task`가 0회 (fan-out 미재현) | `unknown` |
| `malformed-middle.ndjson` | 중간 줄이 깨졌다 | `malformed` 1, `truncated` false |
| `empty.ndjson` | 첫 턴 전에 죽었거나 캡처가 꺼져 있었다 | `unknown` |

## 마지막 줄이 잘려 있는 이유

kill된 프로세스의 마지막 줄은 거의 항상 **쓰다 만 JSON**이다
(`{"type":"assist`). 그것을 파싱 실패로 세면 "형식이 깨졌다"와 "중간에
죽었다"가 같은 숫자로 뭉개진다 — 전자는 파서가 틀렸다는 뜻이고 후자는
정상이라, 대응이 정반대다. `malformed-middle.ndjson`이 그 둘을 가른다.

## `completed.ndjson`이 지키는 것

스트림으로 바꿔도 **완주한 run이 잃는 정보는 없다**는 것. 마지막 `result`
이벤트가 `--output-format json` 봉투와 같은 자리이고, `num_turns`,
`stop_reason`, `total_cost_usd`, `permission_denials`, `subagent_stats`가
그대로 들어 있다. 이것이 깨지면 스트림 전환은 정보를 더하는 것이 아니라
바꿔치기하는 것이 된다.
