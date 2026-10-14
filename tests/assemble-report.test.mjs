import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 리포트 조립을 고정한다. 2026-10-13 실행은 렌더러·스냅숏·타임라인 출력을 PowerShell 변수로 받아 틀의 자리표시자를
// 바꿨고, PowerShell 5.1이 node의 UTF-8 출력을 시스템 코드 페이지로 읽어 한글이 깨진 리포트를 저장했다. 조각은 각
// 스크립트가 `--out`으로 파일에 쓰고, 이 스크립트가 파일끼리 잇는다 — 글이 셸을 지나지 않는다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'assemble-report.mjs')
const TIMELINE = join(ROOT, 'scripts', 'review-timeline.mjs')
const RUN = 'code-review-full-feat-x-2026-10-13'
const RUN_ID = 'run-20261013-feat-x'

const PLAN = `**검토 상태: 완료** — 적용 19개 중 수집 19\n\n출처: \`review-snapshot.mjs\` · \`.timing/${RUN}.snapshot.json\`\n`
const FINDINGS = '## 상세 지적\n\n### 04 상태 관리\n\n#### 🔴 `04-3` 입력 점군 조회 상태가 UI에 반영되지 않는다\n영향: 높음\n'
const START = { host: 'test', rules: 'r', version: '2.26.2', branch: 'feat/x', changedFiles: 1, runId: RUN_ID }
const TEMPLATE = [
  '# feat-x 전체 코드 리뷰 리포트',
  '',
  '## 판정',
  '',
  '**머지 보류.** 한글이 그대로 남아야 한다.',
  '',
  '## 실행 계획',
  '',
  '{{plan}}',
  '',
  '{{findings}}',
  '',
  '## 실행 타임라인',
  '',
  '{{timeline}}',
  '',
  '## 미해결 / 후속 확인',
  '',
  '- 없음',
  '',
].join('\n')

const timing = dir => join(dir, '.timing')
const part = (dir, name) => join(timing(dir), `${RUN}.${name}.md`)

const log = (dir, phase, data, run = RUN) => {
  const out = spawnSync(process.execPath, [TIMELINE, '--dir', dir, '--run', run, '--phase', phase, '--data', JSON.stringify(data)], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
}

/** 실제 `--summary --out`으로 타임라인 표를 뽑는다. */
const summarize = (dir, out, run = RUN) => {
  const table = spawnSync(process.execPath, [TIMELINE, '--dir', dir, '--run', run, '--summary', '--out', out], { encoding: 'utf8' })
  assert.equal(table.status, 0, table.stderr)
}

const tempDir = (t, prefix = 'assemble-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** `render.start`까지 남긴 실행과 조각 셋. */
const readyRun = t => {
  const dir = tempDir(t)
  log(dir, 'run.start', START)
  log(dir, 'render.start', { findings: 1 })
  writeFileSync(part(dir, 'plan'), PLAN, 'utf8')
  writeFileSync(part(dir, 'findings'), FINDINGS, 'utf8')
  summarize(dir, part(dir, 'timeline'))
  const template = join(dir, 'template.md')
  writeFileSync(template, TEMPLATE, 'utf8')
  return { dir, template }
}

const assemble = (dir, template) => spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--template', template], { encoding: 'utf8' })
const reportOf = dir => join(dir, `${RUN}.md`)

test('틀의 자리에 조각 셋을 그대로 끼워 <dir>/<run>.md에 쓰고, render.wrote에 남길 경로와 줄 수를 낸다', t => {
  const { dir, template } = readyRun(t)
  const out = assemble(dir, template)
  assert.equal(out.status, 0, out.stderr)
  const report = readFileSync(reportOf(dir), 'utf8')
  const expected = `${TEMPLATE
    .replace('{{plan}}', PLAN.trimEnd())
    .replace('{{findings}}', FINDINGS.trimEnd())
    .replace('{{timeline}}', readFileSync(part(dir, 'timeline'), 'utf8').trimEnd())
    .trimEnd()}\n`
  assert.equal(report, expected)
  assert.match(report, /\*\*머지 보류\.\*\* 한글이 그대로 남아야 한다\./)
  const written = JSON.parse(out.stdout)
  assert.equal(written.path, reportOf(dir))
  assert.equal(written.lines, report.split('\n').length - 1)
  assert.match(written.sha256, /^[0-9a-f]{64}$/)
})

test('자리표시자가 빠졌거나 두 번이거나 채우지 않은 칸이 남았으면 쓰지 않는다', t => {
  const { dir } = readyRun(t)
  const cases = [
    [TEMPLATE.replace('{{findings}}', ''), /\{\{findings\}\} 줄이 0개다/],
    [TEMPLATE.replace('{{plan}}', '{{plan}}\n\n{{plan}}'), /\{\{plan\}\} 줄이 2개다/],
    [TEMPLATE.replace('**머지 보류.**', '{{VERDICT}}'), /채우지 않은 자리표시자가 있다: \{\{VERDICT\}\}/],
    // 줄 안에 섞인 자리표시자는 조각 자리가 아니다 — 조각은 Markdown 블록이라 줄 하나를 통째로 차지한다
    [TEMPLATE.replace('{{timeline}}', '표: {{timeline}}'), /\{\{timeline\}\} 줄이 0개다/],
  ]
  for (const [text, pattern] of cases) {
    const template = join(dir, 'bad.md')
    writeFileSync(template, text, 'utf8')
    const out = assemble(dir, template)
    assert.equal(out.status, 2, text)
    assert.match(out.stderr, pattern)
    assert.equal(existsSync(reportOf(dir)), false)
  }
})

test('조각 파일이 없거나 다른 실행·다른 시점의 것이면 쓰지 않는다', t => {
  const { dir, template } = readyRun(t)
  const plan = readFileSync(part(dir, 'plan'), 'utf8')

  writeFileSync(part(dir, 'plan'), plan.replace(RUN, 'code-review-full-other-2026-10-13'), 'utf8')
  let out = assemble(dir, template)
  assert.equal(out.status, 2)
  assert.match(out.stderr, /이 실행\(code-review-full-feat-x-2026-10-13\)의 스냅숏 블록이 아니다/)
  writeFileSync(part(dir, 'plan'), plan, 'utf8')

  rmSync(part(dir, 'findings'))
  out = assemble(dir, template)
  assert.equal(out.status, 2)
  assert.match(out.stderr, /findings\.md이 없다 — render-findings\.mjs --out/)
  writeFileSync(part(dir, 'findings'), FINDINGS, 'utf8')

  // 표를 뽑은 뒤 기록이 늘었다 — 중간에 뽑은 표를 그대로 싣지 않는다
  appendFileSync(join(timing(dir), `${RUN}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), seq: 3, phase: 'synthesis.end', clusters: 1 })}\n`)
  out = assemble(dir, template)
  assert.equal(out.status, 2)
  assert.match(out.stderr, /이벤트 2개일 때 뽑은 표인데 지금 기록은 3개다/)
  assert.equal(existsSync(reportOf(dir)), false)
})

test('부분 보고로 닫고 run.resume으로 이어 간 실행은 새 구간의 render.start 뒤에 조립한다', t => {
  // C-12: 한도에 닿아 디스패치를 멈추면 확보한 결과로 부분 보고를 쓰고 `run.end`를 남긴다. 그 실행은
  // `review-tasks.mjs resume`이 연 새 구간(`run.resume`)에서 이어 가고, 끝에서 리포트를 다시 조립한다.
  const dir = tempDir(t)
  const template = join(dir, 'template.md')
  writeFileSync(template, TEMPLATE, 'utf8')
  log(dir, 'run.start', START)
  log(dir, 'dispatch.halt', { reason: 'max-tasks' })
  log(dir, 'render.start', { findings: 1 })
  log(dir, 'render.wrote', { path: reportOf(dir), lines: 20 })
  log(dir, 'run.end', { verdict: 'FAILED orchestration' })
  log(dir, 'run.resume', { maxTasks: 60 })
  writeFileSync(part(dir, 'plan'), PLAN, 'utf8')
  writeFileSync(part(dir, 'findings'), FINDINGS, 'utf8')

  // 새 구간에서는 아직 렌더를 시작하지 않았다 — 앞 구간의 `render.start`로 조립하지 않는다
  summarize(dir, part(dir, 'timeline'))
  let out = assemble(dir, template)
  assert.equal(out.status, 2)
  assert.match(out.stderr, /이 구간에 render\.start가 없다/)

  log(dir, 'render.start', { findings: 1 })
  summarize(dir, part(dir, 'timeline'))
  out = assemble(dir, template)
  assert.equal(out.status, 0, out.stderr)
  assert.match(readFileSync(reportOf(dir), 'utf8'), /\*\*머지 보류\.\*\* 한글이 그대로 남아야 한다\./)
  // 앞 구간의 `run.end`는 부분 보고의 끝이다 — 이 렌더를 고쳐 쓴 것으로 적지 않는다
  assert.doesNotMatch(readFileSync(part(dir, 'timeline'), 'utf8'), /이 렌더를 고쳐 쓴 것/)
})

test('깨진 글자(U+FFFD)가 섞이면 쓰지 않는다', t => {
  const { dir, template } = readyRun(t)
  writeFileSync(part(dir, 'findings'), FINDINGS.replace('입력', '��'), 'utf8')
  const out = assemble(dir, template)
  assert.equal(out.status, 2)
  assert.match(out.stderr, /U\+FFFD/)
  assert.equal(existsSync(reportOf(dir)), false)
})

test('render.start 전이나 run.end 뒤에는 조립하지 않는다', t => {
  const dir = tempDir(t)
  mkdirSync(timing(dir), { recursive: true })
  const template = join(dir, 'template.md')
  writeFileSync(template, TEMPLATE, 'utf8')
  log(dir, 'run.start', START)
  let out = assemble(dir, template)
  assert.equal(out.status, 2)
  assert.match(out.stderr, /render\.start가 없다/)
  log(dir, 'render.start', { findings: 1 })
  log(dir, 'run.end', { verdict: 'WARN' })
  out = assemble(dir, template)
  assert.equal(out.status, 2)
  assert.match(out.stderr, /이미 끝난 실행이다/)
  assert.equal(existsSync(reportOf(dir)), false)
})

test('시작되지 않은 실행과 모르는 플래그는 거부한다', t => {
  const dir = mkdtempSync(join(tmpdir(), 'assemble-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(assemble(dir, join(dir, 'template.md')).status, 2)
  const unknown = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--template', 'x', '--force'], { encoding: 'utf8' })
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /unknown flag --force/)
})
