import { readFileSync } from 'node:fs'

// 실행 중에 오케스트레이터·사람이 쓴 파일을 읽는 공용 길.
//
// 왜 한 곳인가: PowerShell 5.1의 `Set-Content -Encoding UTF8`은 BOM을 붙이고, 기본 `Out-File`은 UTF-16LE로
// 쓴다. 둘 다 `JSON.parse(readFileSync(path, 'utf8'))`가 첫 글자에서 실패한다. 처음에는 그 일을 겪은 자리마다
// 따로 막았다 — 기록 스크립트의 `--data-file`과 작업 대장의 결과 파일. 2026-10-13 실행은 같은 `.planned.json`을
// 기록 스크립트는 받았는데 렌더러의 `--planned`가 받지 못해, 렌더를 BOM을 지운 뒤 다시 돌렸다. 고친 자리가 아닌
// 곳에서 같은 일이 다시 났으므로, 경로를 받아 JSON을 읽는 스크립트는 이 함수를 쓴다.

/**
 * BOM과 UTF-16을 견디며 텍스트를 읽는다. UTF-16BE는 Node 디코더가 없어 바이트를 뒤집어 LE로 읽는다.
 * 읽지 못하면 `readFileSync`의 오류를 그대로 던진다.
 */
export function readTextFile(path) {
  return decodeText(readFileSync(path))
}

/** 바이트를 텍스트로 — BOM(UTF-8·UTF-16LE·UTF-16BE)을 보고 디코딩하고 BOM은 떼어 낸다. */
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le').replace(/^﻿/, '')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes)
    swapped.swap16()
    return swapped.toString('utf16le').replace(/^﻿/, '')
  }
  return bytes.toString('utf8').replace(/^﻿/, '')
}

/** `readTextFile` 뒤 `JSON.parse`. 둘 중 어디서든 실패하면 던진다. */
export function readJsonFile(path) {
  return JSON.parse(readTextFile(path))
}
