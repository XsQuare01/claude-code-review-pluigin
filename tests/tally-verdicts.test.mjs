import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 교차검증 결과를 모델이 손으로 세지 않게 한다.
//
// 2026-09-11 실행은 `crossverify.end`를 `upheld:13, rejected:3`으로 적고,
// 44초 뒤 `upheld:12, rejected:4`로 정정했다. 후보 수는 이미 스크립트가
// 결정적으로 내는데 검증 결과만 눈으로 세고 있었다. 같은 논증이 여기에도 그대로
// 적용된다 — 숫자가 맞더라도 그것이 결정적으로 계산된 것인지 알 수 없다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'tally-verdicts.mjs')
const RUN = 'code-review-full-feat-x-2026-09-11'

const started = t => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.timing'), { recursive: true })
  writeFileSync(join(dir, '.timing', `${RUN}.jsonl`), `${JSON.stringify({
    at: '2026-09-11T00:00:00.000Z', seq: 1, phase: 'run.start',
    host: 'test', rules: 'review-rules', version: '2.13.0', branch: 'b', changedFiles: 68,
  })}\n`, 'utf8')
  return dir
}

const verdict = (candidateId, disposition) => ({
  candidateId, disposition, evidence: '확인했습니다',
  location: { kind: 'verified', path: 'src/a.ts', line: 1, quote: 'q' },
  ...(disposition === 'rejected' ? { rebuttal: { kind: 'other', note: '분류 밖' } } : {}),
  ...(disposition === 'needs-context' ? { reason: '파일 밖을 봐야 합니다' } : {}),
})

const tally = (dir, payload, extra = []) => {
  const input = join(dir, 'verdicts.json')
  writeFileSync(input, JSON.stringify(payload), 'utf8')
  return spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--input', input, ...extra],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const timelineOf = dir => readFileSync(join(dir, '.timing', `${RUN}.jsonl`), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line))

test('disposition별로 센다', t => {
  const dir = started(t)
  const out = tally(dir, { schemaVersion: 1, verdicts: [
    verdict('04-3#1', 'upheld'), verdict('17-1#1', 'upheld'), verdict('16-1#1', 'rejected'),
  ] })
  assert.equal(out.status, 0, out.stderr)
  const counts = JSON.parse(out.stdout)
  assert.equal(counts.upheld, 2)
  assert.equal(counts.rejected, 1)
  assert.equal(counts.needsContext, 0)
  assert.equal(counts.total, 3)
})

test('여러 검증 작업의 출력을 함께 센다', t => {
  // bundle verifier와 isolated verifier가 각자 payload를 낸다. 둘을 합쳐 세는
  // 것이 모델이 하던 일이고, 그 합산이 틀렸던 자리다.
  const dir = started(t)
  const out = tally(dir, [
    { schemaVersion: 1, verdicts: [verdict('04-3#1', 'upheld')] },
    { schemaVersion: 1, verdicts: [verdict('16-1#1', 'rejected'), verdict('18-2#1', 'rejected')] },
  ])
  const counts = JSON.parse(out.stdout)
  assert.equal(counts.upheld, 1)
  assert.equal(counts.rejected, 2)
  assert.equal(counts.total, 3)
})

test('같은 후보를 두 번 판정하면 나중 것이 정본이고 그 사실을 낸다', t => {
  // bundle이 needs-context로 돌린 후보는 isolated로 승격돼 다시 판정된다.
  // 두 줄을 다 세면 total이 부풀고, 첫 줄을 세면 판정이 뒤집힌 것을 놓친다.
  const dir = started(t)
  const out = tally(dir, [
    { schemaVersion: 1, verdicts: [verdict('EX-4#1', 'needs-context')] },
    { schemaVersion: 1, verdicts: [verdict('EX-4#1', 'rejected')] },
  ])
  const counts = JSON.parse(out.stdout)
  assert.equal(counts.total, 1)
  assert.equal(counts.rejected, 1)
  assert.equal(counts.needsContext, 0)
  assert.equal(counts.reverdicted, 1)
})

test('counts를 crossverify.end로 직접 남긴다', t => {
  const dir = started(t)
  tally(dir, { schemaVersion: 1, verdicts: [verdict('04-3#1', 'upheld'), verdict('16-1#1', 'rejected')] },
    ['--malformed-tasks-corrected', '3'])
  const last = timelineOf(dir).at(-1)
  assert.equal(last.phase, 'crossverify.end')
  assert.equal(last.upheld, 1)
  assert.equal(last.rejected, 1)
  assert.equal(last.needsContext, 0)
  assert.equal(last.malformedTasksCorrected, 3)
  assert.equal(last.countsFrom, 'tally-verdicts.mjs')
})

test('알 수 없는 disposition은 조용히 버리지 않는다', t => {
  const dir = started(t)
  const out = tally(dir, { schemaVersion: 1, verdicts: [{ candidateId: 'x#1', disposition: 'confirmed', evidence: 'e' }] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /confirmed/)
})

test('candidateId가 없는 verdict는 셀 수 없다고 말한다', t => {
  const dir = started(t)
  const out = tally(dir, { schemaVersion: 1, verdicts: [{ disposition: 'upheld', evidence: 'e' }] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /candidateId/)
})

test('run.start가 없으면 세지 않는다', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = tally(dir, { schemaVersion: 1, verdicts: [] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /run\.start/)
})

// ── 판정을 받지 못한 후보 ──────────────────────────────────────────────────
//
// 2026-09-18 실행이 대상 16건을 잡고 판정 13건을 남겼다. 나머지 3건은 verifier가
// 두 차례 타임아웃해 판정이 없었는데, 그 사실이 리포트 산문에만 있고 기록에는
// 없었다. 사이드카만 읽으면 3건이 증발한 것으로 보인다.

const withScriptDone = (dir, verify) => {
  const path = join(dir, '.timing', `${RUN}.jsonl`)
  writeFileSync(path, readFileSync(path, 'utf8') + `${JSON.stringify({
    at: '2026-09-11T00:01:00.000Z', seq: 2, phase: 'script.done', ran: true,
    counts: { total: 35, verify, skipVerify: 19, bundle: 3, isolated: 13 },
  })}\n`, 'utf8')
  return dir
}

test('판정을 못 받은 후보 수를 script.done의 대상 수에서 뺄셈으로 낸다', t => {
  const dir = withScriptDone(started(t), 4)
  const out = tally(dir, { verdicts: [verdict('c1', 'upheld'), verdict('c2', 'upheld')] })
  assert.equal(out.status, 0, out.stderr)
  const line = timelineOf(dir).at(-1)
  assert.equal(line.phase, 'crossverify.end')
  assert.equal(line.upheld, 2)
  assert.equal(line.noVerdict, 2)
})

test('전부 판정됐으면 0을 적는다 — 미측정과 구분한다', t => {
  const dir = withScriptDone(started(t), 2)
  const out = tally(dir, { verdicts: [verdict('c1', 'upheld'), verdict('c2', 'rejected')] })
  assert.equal(out.status, 0, out.stderr)
  const line = timelineOf(dir).at(-1)
  assert.equal(line.noVerdict, 0)
})

test('대상 수를 읽지 못하면 noVerdict를 만들지 않는다', t => {
  // script.done이 없으면 뺄셈의 한쪽이 없다. 0으로 채우면 "전부 판정됐다"는
  // 주장이 되는데, 그것은 재지 않은 값이다.
  const dir = started(t)
  const out = tally(dir, { verdicts: [verdict('c1', 'upheld')] })
  assert.equal(out.status, 0, out.stderr)
  const line = timelineOf(dir).at(-1)
  assert.equal(line.noVerdict, undefined)
})

test('재판정이 있어도 후보 단위로 빼서 센다', t => {
  // 같은 후보가 bundle에서 needs-context, isolated에서 upheld를 받으면 판정은
  // 둘이지만 후보는 하나다. 판정 수로 빼면 대상이 남아돌지 않는데도 남는다.
  const dir = withScriptDone(started(t), 2)
  const out = tally(dir, { verdicts: [verdict('c1', 'needs-context'), verdict('c1', 'upheld')] })
  assert.equal(out.status, 0, out.stderr)
  const line = timelineOf(dir).at(-1)
  assert.equal(line.upheld, 1)
  assert.equal(line.noVerdict, 1)
})

// ── 대상을 ID로 본다 ───────────────────────────────────────────────────────
//
// 개수만 맞추면 다른 후보가 누락을 가린다. 대상이 A·B인데 verdict가 A·X로 오면
// 대상 2 · 판정 2 · noVerdict 0이 되어 검사를 통과하고, 정작 B는 사라진다.

const routedFile = (dir, entries) => {
  const path = join(dir, 'routed.json')
  writeFileSync(path, JSON.stringify({ candidates: entries }), 'utf8')
  return path
}

test('--targets는 빠진 대상을 ID로 가려낸다', t => {
  const dir = withScriptDone(started(t), 2)
  const targets = routedFile(dir, [
    { candidateId: 'A', route: 'isolated' },
    { candidateId: 'B', route: 'bundle' },
  ])
  const out = tally(dir, { verdicts: [verdict('A', 'upheld')] }, ['--targets', targets])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(timelineOf(dir).at(-1).noVerdict, 1)
})

test('--targets는 대상 밖 후보의 판정을 거부한다', t => {
  // 개수만 보면 통과하는 바로 그 기록이다: 대상 2 · 판정 2 · noVerdict 0.
  const dir = withScriptDone(started(t), 2)
  const targets = routedFile(dir, [
    { candidateId: 'A', route: 'isolated' },
    { candidateId: 'B', route: 'isolated' },
  ])
  const out = tally(dir, { verdicts: [verdict('A', 'upheld'), verdict('X', 'upheld')] }, ['--targets', targets])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /검증 대상이 아닌 후보의 판정이 있다.*X/)
})

test('--targets는 route가 none인 후보를 대상으로 세지 않는다', t => {
  // 띄우지 않은 것을 "판정을 못 받았다"로 세면 정상 실행마다 값이 부푼다.
  const dir = withScriptDone(started(t), 1)
  const targets = routedFile(dir, [
    { candidateId: 'A', route: 'isolated' },
    { candidateId: 'B', route: 'none' },
  ])
  const out = tally(dir, { verdicts: [verdict('A', 'upheld')] }, ['--targets', targets])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(timelineOf(dir).at(-1).noVerdict, 0)
})

test('--targets 없이 센 noVerdict에는 그 한계를 적는다', t => {
  // 숫자만 보면 두 방식의 결과가 같아 보인다.
  const dir = withScriptDone(started(t), 3)
  const out = tally(dir, { verdicts: [verdict('A', 'upheld')] })
  assert.equal(out.status, 0, out.stderr)
  const line = timelineOf(dir).at(-1)
  assert.equal(line.noVerdict, 2)
  assert.match(line.note, /--targets 없이는 후보 ID 불일치를 잡지 못한다/)
})

test('--targets로 세면 그 한계 문구를 붙이지 않는다', t => {
  const dir = withScriptDone(started(t), 1)
  const targets = routedFile(dir, [{ candidateId: 'A', route: 'isolated' }])
  const out = tally(dir, { verdicts: [verdict('A', 'upheld')] }, ['--targets', targets])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(timelineOf(dir).at(-1).note, undefined)
})

test('--targets에 대상이 하나도 없으면 거부한다', t => {
  const dir = withScriptDone(started(t), 1)
  const targets = routedFile(dir, [{ candidateId: 'A', route: 'none' }])
  const out = tally(dir, { verdicts: [verdict('A', 'upheld')] }, ['--targets', targets])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /검증 대상이 없다/)
})

test('stdout에 판정 집합을 빈 객체로 흘리지 않는다', t => {
  // JSON.stringify는 Set을 {}로 내보낸다. 호출자에게 빈 값처럼 보인다.
  const dir = withScriptDone(started(t), 2)
  const out = tally(dir, { verdicts: [verdict('A', 'upheld')] })
  const printed = JSON.parse(out.stdout)
  assert.equal(printed.judged, undefined)
  assert.equal(printed.upheld, 1)
  assert.equal(printed.noVerdict, 1)
})

// ── 작업별 판정 파일 모으기 (--collect) ─────────────────────────────────────
//
// 2026-09-30 실행은 검증자 19개의 판정을 대화에서 들고 있다가, 서브에이전트에게
// 세션 기록을 긁어 판정 파일 두 개를 만들게 했다(17분). 그 파일은 `{ tasks: [...] }`
// 모양이라 렌더러가 읽지 못해 모양을 다시 바꿨다(5분). 검증자가 돌려준 JSON을
// `prepare-verification.mjs`가 정해 준 자리(`verifierTasks[].verdict`)에 받는 즉시
// 남기면, 모으는 일과 순서를 정하는 일은 스크립트의 몫이 된다.

const verifyTasks = dir => {
  const verify = join(dir, '.timing', `${RUN}.verify`)
  mkdirSync(verify, { recursive: true })
  const at = name => ({ prompt: join(verify, `${name}.md`), verdict: join(verify, `${name}.verdict.json`) })
  const routed = {
    candidates: [{ candidateId: '04-3#1', route: 'bundle' }, { candidateId: 'A-8#1', route: 'isolated' }],
    verifierTasks: [
      { taskId: 'bundle-1', route: 'bundle', candidateIds: ['04-3#1'], ...at('bundle-1') },
      { taskId: 'isolated-A-8-1', route: 'isolated', candidateIds: ['A-8#1'], ...at('isolated-A-8-1') },
    ],
    promotions: { '04-3#1': { taskId: 'isolated-04-3-1', ...at('isolated-04-3-1') } },
  }
  const routedPath = join(dir, '.timing', `${RUN}.routed.json`)
  writeFileSync(routedPath, JSON.stringify(routed), 'utf8')
  const answer = (name, ...verdicts) => writeFileSync(at(name).verdict, JSON.stringify({ schemaVersion: 1, verdicts }), 'utf8')
  return { routedPath, answer }
}

const collectTally = (dir, extra) => spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--collect', ...extra],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

test('--collect는 작업별 판정 파일을 bundle → isolated → 승격 순서로 모은다', t => {
  const dir = started(t)
  const { routedPath, answer } = verifyTasks(dir)
  answer('bundle-1', verdict('04-3#1', 'needs-context'))
  answer('isolated-A-8-1', verdict('A-8#1', 'rejected'))
  answer('isolated-04-3-1', verdict('04-3#1', 'upheld'))
  const out = collectTally(dir, ['--targets', routedPath])
  assert.equal(out.status, 0, out.stderr)
  const counts = JSON.parse(out.stdout)
  // 승격 판정이 bundle 판정보다 먼저 읽혔다면 04-3#1은 needs-context로 남는다.
  assert.equal(counts.upheld, 1)
  assert.equal(counts.rejected, 1)
  assert.equal(counts.needsContext, 0)
  assert.equal(counts.reverdicted, 1)
  assert.equal(counts.noVerdict, 0)
})

test('--collect는 모은 판정을 렌더러가 읽을 파일 하나로 남긴다', t => {
  const dir = started(t)
  const { routedPath, answer } = verifyTasks(dir)
  answer('bundle-1', verdict('04-3#1', 'upheld'))
  answer('isolated-A-8-1', verdict('A-8#1', 'upheld'))
  const out = collectTally(dir, ['--targets', routedPath])
  assert.equal(out.status, 0, out.stderr)
  const combined = JSON.parse(readFileSync(JSON.parse(out.stdout).verdictsFile, 'utf8'))
  assert.deepEqual(combined.tasks.map(payload => payload.verdicts[0].candidateId), ['04-3#1', 'A-8#1'])
})

test('--collect는 판정 파일이 없는 작업을 noVerdict로 세고 어느 작업인지 알린다', t => {
  const dir = started(t)
  const { routedPath, answer } = verifyTasks(dir)
  answer('bundle-1', verdict('04-3#1', 'upheld'))
  const out = collectTally(dir, ['--targets', routedPath])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(JSON.parse(out.stdout).noVerdict, 1)
  assert.match(out.stderr, /isolated-A-8-1/)
})

test('--collect에는 어느 작업을 읽을지 담은 --targets가 필요하다', t => {
  const dir = started(t)
  const out = collectTally(dir, [])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--targets/)
})

// 교차검증의 끝은 시작과 짝이다. 잘못 센 수치를 바로잡으려고 다시 돌리면 끝이 둘이
// 되는데, append 전용 기록에서 그것은 `note`를 단 정정 줄이어야 한다 — 그래야
// `--check`가 "판정을 다시 받았다"와 "다시 셌다"를 가른다.
test('--note를 주면 crossverify.end에 정정 사유를 남긴다', t => {
  const dir = started(t)
  const out = tally(dir, { schemaVersion: 1, verdicts: [verdict('04-3#1', 'upheld')] }, ['--note', '교정 횟수를 빠뜨려 다시 셌다'])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(timelineOf(dir).at(-1).note, '교정 횟수를 빠뜨려 다시 셌다')
})

// ── 판정 형식 검증과 교정 프롬프트 (--validate) ──────────────────────────────
//
// `feat/scene-graph-undo-redo` 실행(2026-09-30)의 검증자 10개 중 5개가 형식을
// 어겼다 — `location`을 문자열로 쓰거나 `kind`를 빠뜨렸다. 오케스트레이터가 같은
// 세션으로 교정하려 하자 런타임이 `task-not-found`를 냈고, 새 작업으로 "수리"할 때는
// 오케스트레이터가 "이 근거를 보존하라"며 판정 근거를 직접 불러 줬다 — 판정을
// 검증자가 아니라 오케스트레이터가 쓴 셈이다. 형식 검사와 교정 프롬프트를 스크립트가
// 만들면, 교정은 같은 지시 + 오류 목록 + 직전 응답 원문으로만 이뤄진다.

const withPrompts = dir => {
  const setup = verifyTasks(dir)
  const routed = JSON.parse(readFileSync(setup.routedPath, 'utf8'))
  for (const task of [...routed.verifierTasks, ...Object.values(routed.promotions)]) {
    writeFileSync(task.prompt, `# 원래 지시 ${task.taskId}\n`, 'utf8')
  }
  return { ...setup, routed }
}
const validateRun = (dir, routedPath) => spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--run', RUN, '--validate', '--targets', routedPath],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

test('--validate는 계약을 어긴 판정 파일을 작업 이름으로 짚고 교정 프롬프트를 만든다', t => {
  const dir = started(t)
  const { routedPath, answer, routed } = withPrompts(dir)
  answer('bundle-1', { ...verdict('04-3#1', 'upheld'), location: 'src/a.ts:1' })
  answer('isolated-A-8-1', verdict('A-8#1', 'upheld'))
  const out = validateRun(dir, routedPath)
  assert.equal(out.status, 1)
  const report = JSON.parse(out.stdout)
  assert.deepEqual(report.malformed.map(entry => entry.taskId), ['bundle-1'])
  const retry = readFileSync(report.malformed[0].retryPrompt, 'utf8')
  assert.match(retry, /^# 원래 지시 bundle-1\n/)
  assert.match(retry, /location/)
  assert.match(retry, /src\/a\.ts:1/)
  assert.equal(report.malformed[0].retryPrompt, routed.verifierTasks[0].prompt.replace(/\.md$/, '.retry.md'))
  // 검사만 한다 — 교차검증의 끝을 기록하지 않는다.
  assert.equal(timelineOf(dir).some(event => event.phase === 'crossverify.end'), false)
})

test('--validate는 요청하지 않은 candidateId를 돌려준 판정도 형식 위반으로 본다', t => {
  const dir = started(t)
  const { routedPath, answer } = withPrompts(dir)
  answer('bundle-1', verdict('04-3#1', 'upheld'), verdict('A-8#1', 'upheld'))
  answer('isolated-A-8-1', verdict('A-8#1', 'upheld'))
  const out = validateRun(dir, routedPath)
  assert.equal(out.status, 1)
  const [entry] = JSON.parse(out.stdout).malformed
  assert.equal(entry.taskId, 'bundle-1')
  assert.match(entry.problems.join('\n'), /A-8#1/)
})

test('--validate는 판정이 모두 계약에 맞으면 0으로 끝나고 교정 프롬프트를 만들지 않는다', t => {
  const dir = started(t)
  const { routedPath, answer } = withPrompts(dir)
  answer('bundle-1', verdict('04-3#1', 'upheld'))
  answer('isolated-A-8-1', verdict('A-8#1', 'rejected'))
  const out = validateRun(dir, routedPath)
  assert.equal(out.status, 0, out.stdout)
  assert.deepEqual(JSON.parse(out.stdout).malformed, [])
})

test('--collect는 교정 뒤에도 계약을 어긴 판정을 세지 않고, 교정한 작업 수를 스스로 센다', t => {
  const dir = started(t)
  const { routedPath, answer, routed } = withPrompts(dir)
  // bundle-1은 한 번 교정됐고(retry 파일이 있다) 이제 맞다. isolated는 교정 뒤에도 틀렸다.
  writeFileSync(routed.verifierTasks[0].prompt.replace(/\.md$/, '.retry.md'), '교정 지시', 'utf8')
  writeFileSync(routed.verifierTasks[1].prompt.replace(/\.md$/, '.retry.md'), '교정 지시', 'utf8')
  answer('bundle-1', verdict('04-3#1', 'upheld'))
  answer('isolated-A-8-1', { ...verdict('A-8#1', 'upheld'), location: { path: 'src/a.ts', line: 1, quote: 'q' } })
  const out = collectTally(dir, ['--targets', routedPath])
  assert.equal(out.status, 0, out.stderr)
  const counts = JSON.parse(out.stdout)
  assert.equal(counts.upheld, 1)
  assert.equal(counts.noVerdict, 1)
  assert.match(out.stderr, /isolated-A-8-1/)
  assert.equal(timelineOf(dir).at(-1).malformedTasksCorrected, 2)
})

// ── 승격은 bundle의 needs-context에만 따른다 ────────────────────────────────
//
// bundle이 `needs-context`로 돌린 후보는 isolated로 다시 판정받아야 한다(SKILL).
// 승격 판정이 없을 때 bundle의 `needs-context`를 최종 판정으로 세면, 계약이 isolated에서도
// 닫히지 않은 후보에만 주는 `미해결 / 후속 확인`으로 그려지고 판정 없음은 0으로 보인다 —
// 해야 할 검증을 건너뛴 사실이 어디에도 남지 않는다. 반대로 bundle이 이미 닫은 후보의
// 승격 판정을 세면, 그것은 계약에 없는 재검증으로 판정을 뒤집는 경로가 된다.

test('--collect는 bundle의 needs-context에 승격 판정이 없으면 판정 없음으로 세고 그 후보를 알린다', t => {
  const dir = started(t)
  const { routedPath, answer } = verifyTasks(dir)
  answer('bundle-1', verdict('04-3#1', 'needs-context'))
  answer('isolated-A-8-1', verdict('A-8#1', 'upheld'))
  const out = collectTally(dir, ['--targets', routedPath])
  assert.equal(out.status, 0, out.stderr)
  const counts = JSON.parse(out.stdout)
  assert.equal(counts.needsContext, 0)
  assert.equal(counts.upheld, 1)
  assert.equal(counts.noVerdict, 1)
  assert.match(out.stderr, /승격/)
  assert.match(out.stderr, /04-3#1/)
  // 렌더러가 읽을 파일에도 bundle의 needs-context가 남지 않아야 둘이 같은 결론을 낸다.
  const combined = JSON.parse(readFileSync(counts.verdictsFile, 'utf8'))
  const ids = combined.tasks.flatMap(payload => payload.verdicts.map(entry => entry.candidateId))
  assert.deepEqual(ids, ['A-8#1'])
})

test('--collect는 승격 판정이 계약을 어겼으면 bundle의 needs-context도 최종 판정으로 쓰지 않는다', t => {
  const dir = started(t)
  const { routedPath, answer } = verifyTasks(dir)
  answer('bundle-1', verdict('04-3#1', 'needs-context'))
  answer('isolated-A-8-1', verdict('A-8#1', 'upheld'))
  answer('isolated-04-3-1', { ...verdict('04-3#1', 'upheld'), location: 'src/a.ts:1' })
  const out = collectTally(dir, ['--targets', routedPath])
  assert.equal(out.status, 0, out.stderr)
  const counts = JSON.parse(out.stdout)
  assert.equal(counts.needsContext, 0)
  assert.equal(counts.noVerdict, 1)
  assert.match(out.stderr, /isolated-04-3-1/)
})

test('--collect는 bundle이 이미 닫은 후보의 승격 판정을 세지 않고 그 사실을 알린다', t => {
  const dir = started(t)
  const { routedPath, answer } = verifyTasks(dir)
  answer('bundle-1', verdict('04-3#1', 'upheld'))
  answer('isolated-A-8-1', verdict('A-8#1', 'upheld'))
  answer('isolated-04-3-1', verdict('04-3#1', 'rejected'))
  const out = collectTally(dir, ['--targets', routedPath])
  assert.equal(out.status, 0, out.stderr)
  const counts = JSON.parse(out.stdout)
  assert.equal(counts.upheld, 2)
  assert.equal(counts.rejected, 0)
  assert.equal(counts.reverdicted, 0)
  assert.match(out.stderr, /isolated-04-3-1/)
})
