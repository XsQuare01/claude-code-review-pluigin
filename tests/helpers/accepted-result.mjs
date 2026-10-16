import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

// 모델 대신 고정 응답을 쓰는 통합 fixture. 수신 경로 자체는 review-tasks-cli 테스트가 검사한다.
export function writeAcceptedResult({ log, path, stage, task, payload }) {
  const identity = stage === 'module' ? { module: task } : { task }
  const taskId = `fixture-${stage}-${task}`
  const raw = JSON.stringify(payload)
  log({ phase: `${stage}.start`, ...identity, attempt: 1 })
  log({ phase: 'task.bind', stage, task, attempt: 1, taskId })
  writeFileSync(path, raw, 'utf8')
  log({ phase: `${stage}.done`, ...identity, attempt: 1, status: 'ok', taskId,
    resultSha256: createHash('sha256').update(raw).digest('hex') })
}
