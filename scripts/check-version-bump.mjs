#!/usr/bin/env node
// Fails when anything changed without bumping the plugin version.
//
// Claude Code uses the version string in plugin.json as the cache key. Pushing new
// commits under an unchanged version leaves every installed copy stale, and nothing
// reports it — installs keep looking healthy while running old rules. This turns that
// silent failure into a failed check.
//
// Every change bumps the version, including documentation. Deciding per-change whether
// something "ships" is a judgment call, and a judgment call is where the exception that
// breaks the rule gets made. A spare patch number costs nothing; a stale install costs
// an hour of reviewing against the wrong rules.
//
// Usage: node scripts/check-version-bump.mjs <base-ref>
//   e.g. node scripts/check-version-bump.mjs origin/main

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = '.claude-plugin/plugin.json'

const base = process.argv[2] ?? 'origin/main'

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

let mergeBase
try {
  mergeBase = git('merge-base', base, 'HEAD')
} catch {
  console.error(`cannot resolve merge-base with "${base}" — fetch it first (actions/checkout needs fetch-depth: 0)`)
  process.exit(2)
}

const changed = git('diff', '--name-only', `${mergeBase}..HEAD`).split('\n').filter(Boolean)

if (changed.length === 0) {
  console.log('OK — nothing changed, version bump not required')
  process.exit(0)
}

let current
try {
  current = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8')).version
} catch (err) {
  console.error(`${MANIFEST} is missing or not valid JSON: ${err.message}`)
  process.exit(2)
}

let previous
try {
  previous = JSON.parse(git('show', `${mergeBase}:${MANIFEST}`)).version
} catch {
  console.log('OK — no plugin manifest at the merge base, treating this as the first release')
  process.exit(0)
}

if (current === previous) {
  console.error(`${changed.length} file(s) changed but plugin.json version is still ${current}.`)
  console.error('')
  console.error('Claude Code keys its plugin cache on this string. Without a bump, installed')
  console.error('copies stay on the old content and report themselves as up to date.')
  console.error('')
  for (const f of changed.slice(0, 20)) console.error(`  - ${f}`)
  if (changed.length > 20) console.error(`  … and ${changed.length - 20} more`)
  console.error('')
  console.error(`Bump the "version" field in ${MANIFEST}:`)
  console.error('  PATCH (2.2.0 -> 2.2.1) is the default — fixes, wording, docs,')
  console.error('        new rules inside an existing module, workflow tuning')
  console.error('  MINOR (2.2.1 -> 2.3.0) a new rule module file, a new command or flag,')
  console.error('        or a substantial validated capability gain such as the registered structured owners')
  console.error('        receiving an internal producer->orchestrator interface that adds validated structured output')
  console.error('        while keeping the public Markdown contract compatible; internal producer changes alone are not automatic MINOR')
  console.error('  MAJOR for changes that invalidate existing rule IDs or reports')
  console.error('  When unsure, use PATCH.')
  process.exit(1)
}

console.log(`OK — ${changed.length} file(s) changed, version ${previous} → ${current}`)
