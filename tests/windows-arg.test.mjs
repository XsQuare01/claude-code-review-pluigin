import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import { windowsArg, windowsCommandLine } from '../scripts/lib/windows-arg.mjs'

// `review-tool --detach`는 Windows에서 도구를 PowerShell `Start-Process`로 띄운다. 그 실행은 인자를 문자열 하나로만
// 받으므로, 인자 배열을 명령줄로 옮긴 것이 받는 쪽(Node)에서 같은 배열로 돌아와야 한다. 셸 명령 문자열(`--shell`)과
// 리포트 폴더 경로(`바탕 화면`)에는 공백·따옴표·한글이 들어간다.
const TRICKY = [
  'plain',
  'C:\\Users\\me\\바탕 화면\\Docs',
  'npm --prefix "apps/my app" test',
  'say "hi" \\"x\\"',
  'C:\\끝 역슬래시\\',
  '',
  'a\\\\b',
  '%PATH% $env:X',
]

test('공백·따옴표가 없으면 그대로, 있으면 감싸고 따옴표와 끝 역슬래시를 받는 쪽 규칙대로 적는다', () => {
  assert.equal(windowsArg('plain'), 'plain')
  assert.equal(windowsArg('a\\b'), 'a\\b')
  assert.equal(windowsArg(''), '""')
  assert.equal(windowsArg('a b'), '"a b"')
  assert.equal(windowsArg('say "hi"'), '"say \\"hi\\""')
  assert.equal(windowsArg('C:\\a b\\'), '"C:\\a b\\\\"')
  assert.equal(windowsArg('x\\"y z'), '"x\\\\\\"y z"')
})

test('Windows: 옮긴 명령줄을 Node가 같은 인자 배열로 읽는다', {
  skip: process.platform !== 'win32' && '명령줄을 그대로 넘기는 실행은 Windows에만 있다',
}, () => {
  // windowsVerbatimArguments로 명령줄을 손대지 않고 넘긴다 — Start-Process -ArgumentList와 같은 처지다.
  // 그 모드에서는 실행 파일 경로(argv0)도 감싸지 않으므로 직접 감싼다(`Program Files`의 공백)
  const echo = spawnSync(process.execPath, ['-e', '"process.stdout.write(JSON.stringify(process.argv.slice(1)))"', windowsCommandLine(TRICKY)], {
    windowsVerbatimArguments: true, argv0: windowsArg(process.execPath), encoding: 'utf8',
  })
  assert.equal(echo.status, 0, echo.stderr)
  assert.deepEqual(JSON.parse(echo.stdout), TRICKY)
})
