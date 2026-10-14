#!/usr/bin/env node
// 리포트를 조립한다 — 오케스트레이터가 쓴 틀에 스크립트가 만든 조각 셋을 그대로 끼운다.
//
// 왜 있는가: `실행 계획`(스냅숏)·`상세 지적`과 `특수 패스`(렌더러)·`실행 타임라인`(`--summary`)은 이미 완성된
// Markdown이고, 오케스트레이터가 새로 쓰는 것은 판정·요약·도구 실행 결과·미해결뿐이다. 그런데 조각을 셸이 표준
// 출력으로 받아 옮기면 PowerShell 5.1이 node의 UTF-8 출력을 시스템 코드 페이지로 읽어 한글을 깨뜨린다. 2026-10-13
// 실행은 세 출력을 셸 변수로 받아 틀의 자리표시자를 바꾸는 스크립트를 그 자리에서 지어 썼고, 한글이 깨진 리포트를
// 저장한 뒤에야 알아채 다시 조립했다. 조각은 각 스크립트가 `--out`으로 파일에 쓰고, 여기서 파일끼리 잇는다 —
// 글이 셸을 지나지 않는다.
//
// Usage:
//
//   assemble-report.mjs --dir <리포트 디렉터리> --run <리포트 basename> --template <틀 경로>
//
// 틀은 오케스트레이터가 파일 쓰기 도구로 쓴 Markdown이다. 스크립트가 만든 조각이 들어갈 자리에 아래 줄을 **그 줄만**
// 둔다. 각각 정확히 한 번 있어야 한다:
//
//   {{plan}}      → .timing/<run>.plan.md      (review-snapshot.mjs --out)
//   {{findings}}  → .timing/<run>.findings.md  (render-findings.mjs --out)
//   {{timeline}}  → .timing/<run>.timeline.md  (review-timeline.mjs --summary --out, `render.start` 뒤에 뽑은 것)
//
// 조립은 지금 구간(마지막 `run.start`·`run.resume` 뒤)의 `render.start` 뒤에 하고, 그 구간에 `run.end`가 있으면
// 하지 않는다.
//
// 리포트는 `<dir>/<run>.md`에 쓴다(C-7). 표준 출력은 JSON 하나 — `path`·`lines`·`sha256`. `render.wrote`에 그
// `path`와 `lines`를 남긴다. 거부하면(종료 코드 2) 아무것도 쓰지 않은 것이다.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeOutFile } from './lib/atomic-write.mjs'
import { readEvents, requireStartedTimeline } from './lib/run-record.mjs'
import { endState, segmentOf } from './lib/task-ledger.mjs'

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const VALUE_FLAGS = new Set(['dir', 'run', 'template'])
const values = new Map()
{
  const argv = process.argv.slice(2)
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    // 값에 공백이 있으면 셸이 거기서 쪼갠다 — 남은 토큰을 조용히 버리지 않는다(review-preflight.mjs와 같은 이유).
    if (!arg.startsWith('--')) die(`unexpected argument ${JSON.stringify(arg)} — 값에 공백이 있으면 따옴표로 감싸라`)
    const name = arg.slice(2)
    if (!VALUE_FLAGS.has(name)) die(`unknown flag ${arg}`)
    if (values.has(name)) die(`--${name}이 두 번 왔다`)
    const value = argv[at + 1]
    if (value === undefined || value.startsWith('--')) die(`${arg} needs a value`)
    values.set(name, value)
    at += 1
  }
}
const dir = values.get('dir')
const run = values.get('run')
const templatePath = values.get('template')
if (!templatePath) die('usage: assemble-report.mjs --dir <리포트 디렉터리> --run <리포트 basename> --template <틀 경로>')

const sidecar = requireStartedTimeline(dir, run)
const events = readEvents(sidecar)
// 조립은 지금 구간의 `render.start`와 `run.end` 사이의 일이다(C-7·C-9). 끝은 지금 구간의 `run.end`다 — 한도에
// 닿아 부분 보고로 닫은 실행은 `run.resume`으로 새 구간을 열어 이어 가고(C-12), 그 끝에서 리포트를 다시 조립한다.
// 기록 어딘가에 `run.end`가 있다는 것으로 끝났다고 보면 그 흐름이 막힌다(PR #105 리뷰에서 재현). 끝났는지는
// `review-tasks.mjs`와 같은 정의(`endState`)로 본다.
if (endState(events).ended) die(`이미 끝난 실행이다(${sidecar}의 마지막 구간에 run.end가 있다) — 리포트를 다시 조립하지 않는다. 부분 보고를 이어 가려면 review-tasks.mjs resume으로 새 구간을 먼저 연다`)
const segment = segmentOf(events)
if (!events.some(event => event?.phase === 'render.start')) die('render.start가 없다 — `review-timeline.mjs --phase render.start`를 남긴 뒤 조각을 만들고 조립한다')
// 앞 구간의 `render.start`는 부분 보고를 그릴 때 남긴 것이다. 새 구간은 검증을 다시 하므로 렌더도 다시 시작한다 —
// 그 전에 조립하면 부분 보고의 조각이 실린다.
if (!events.slice(segment.index).some(event => event?.phase === 'render.start')) {
  die('이 구간에 render.start가 없다 — 앞 구간(부분 보고)의 render.start다. `review-timeline.mjs --phase render.start`를 남긴 뒤 조각을 다시 만들고 조립한다')
}

const PARTS = [
  { name: 'plan', from: 'review-snapshot.mjs --out' },
  { name: 'findings', from: 'render-findings.mjs --out' },
  { name: 'timeline', from: 'review-timeline.mjs --summary --out' },
]
const partPath = name => join(dir, '.timing', `${run}.${name}.md`)

let template
try {
  template = readFileSync(templatePath, 'utf8')
} catch (error) {
  die(`--template을 읽지 못했다: ${templatePath} — ${error.message}`)
}

const lines = template.replace(/\r\n?/g, '\n').split('\n')
for (const { name, from } of PARTS) {
  const at = lines.flatMap((line, index) => (line.trim() === `{{${name}}}` ? [index] : []))
  if (at.length !== 1) {
    die(`틀에 {{${name}}} 줄이 ${at.length}개다 — 정확히 한 번, 그 줄만 둔다. 그 자리에 ${from}이 쓴 ${partPath(name)}이 들어간다`)
  }
}
// 남은 자리표시자는 채우지 않은 칸이다. 그대로 저장하면 리포트에 `{{VERDICT}}`가 남는다.
const leftover = [...new Set(lines.flatMap(line => line.match(/\{\{[^{}\n]*\}\}/g) ?? []))]
  .filter(token => !PARTS.some(({ name }) => token === `{{${name}}}`))
if (leftover.length) die(`틀에 채우지 않은 자리표시자가 있다: ${leftover.join(', ')} — 오케스트레이터가 쓸 칸이면 내용을 쓰고, 스크립트 조각이면 {{plan}}·{{findings}}·{{timeline}} 중 하나다`)

const parts = new Map()
for (const { name, from } of PARTS) {
  const path = partPath(name)
  if (!existsSync(path)) die(`${path}이 없다 — ${from} "${path}"로 먼저 쓴다`)
  parts.set(name, readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').replace(/\n+$/, ''))
}

// 같은 실행의 조각인지 본다. 스냅숏 블록은 자기 파일을, 타임라인 표는 자기 사이드카와 그때의 이벤트 수를 적는다.
if (!parts.get('plan').includes(`.timing/${run}.snapshot.json`)) {
  die(`${partPath('plan')}은 이 실행(${run})의 스냅숏 블록이 아니다 — review-snapshot.mjs --dir … --run ${run} --out으로 다시 쓴다`)
}
{
  const source = parts.get('timeline').match(/이벤트 (\d+)개 · 마지막 `([^`]+)`/)
  if (!source) die(`${partPath('timeline')}에 출처 줄이 없다 — review-timeline.mjs --summary --out이 쓴 표가 아니다`)
  // `--summary`는 `render.start`를 남긴 뒤에 뽑는다(C-7). 그 뒤로 기록이 늘었거나 줄었으면 다른 시점의 표다 — 2026-09
  // 한 리포트가 교차검증 직후에 뽑은 4줄짜리 표를 실었고, 빠진 9줄에 두 번째로 긴 구간이 있었다.
  if (Number(source[1]) !== events.length) {
    die(`${partPath('timeline')}은 이벤트 ${source[1]}개일 때 뽑은 표인데 지금 기록은 ${events.length}개다 — render.start를 남긴 뒤 review-timeline.mjs --summary --out을 다시 돌린다`)
  }
}

const report = `${lines.map(line => {
  const part = PARTS.find(({ name }) => line.trim() === `{{${name}}}`)
  return part ? parts.get(part.name) : line
}).join('\n').replace(/\n+$/, '')}\n`

// 깨진 글자가 섞였으면 저장하지 않는다. 틀은 파일 쓰기 도구가, 조각은 node가 UTF-8로 쓰므로 정상 경로에서는 나오지 않는다.
if (report.includes('�')) die('조립한 리포트에 깨진 글자(U+FFFD)가 있다 — 틀이나 조각이 UTF-8이 아닌 길로 쓰였다. 셸 출력을 옮겨 쓴 파일이 있는지 본다')

const reportPath = join(dir, `${run}.md`)
let written
try {
  written = writeOutFile(reportPath, report)
} catch (error) {
  die(`리포트를 쓰지 못했다: ${reportPath} — ${error.message}`)
}
process.stdout.write(`${JSON.stringify({ path: written.out, lines: written.lines, sha256: written.sha256 })}\n`)
