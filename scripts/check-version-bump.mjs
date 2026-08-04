#!/usr/bin/env node
// Fails when shipped content changed without bumping the plugin version.
//
// Claude Code uses the version string in plugin.json as the cache key. Pushing new
// commits under an unchanged version leaves every installed copy stale, and nothing
// reports it — installs keep looking healthy while running old rules. This turns that
// silent failure into a failed check.
//
// Usage: node scripts/check-version-bump.mjs <base-ref>
//   e.g. node scripts/check-version-bump.mjs origin/main

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = '.claude-plugin/plugin.json'

/** Paths whose contents reach an installed plugin. Changing any of them must ship a new version. */
const SHIPPED = ['review-rules/', 'skills/', 'agents/', '.claude-plugin/']

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
const shipped = changed.filter(f => SHIPPED.some(p => f.startsWith(p)))

if (shipped.length === 0) {
  console.log('OK — no shipped content changed, version bump not required')
  process.exit(0)
}

const current = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8')).version
let previous
try {
  previous = JSON.parse(git('show', `${mergeBase}:${MANIFEST}`)).version
} catch {
  console.log('OK — no plugin manifest at the merge base, treating this as the first release')
  process.exit(0)
}

if (current === previous) {
  console.error(`Shipped content changed but plugin.json version is still ${current}.`)
  console.error('')
  console.error('Claude Code keys its plugin cache on this string. Without a bump, installed')
  console.error('copies stay on the old content and report themselves as up to date.')
  console.error('')
  console.error(`Changed under ${SHIPPED.join(', ')}:`)
  for (const f of shipped.slice(0, 20)) console.error(`  - ${f}`)
  if (shipped.length > 20) console.error(`  … and ${shipped.length - 20} more`)
  console.error('')
  console.error(`Bump the "version" field in ${MANIFEST} (PATCH for fixes, MINOR for new rules or modules).`)
  process.exit(1)
}

console.log(`OK — ${shipped.length} shipped file(s) changed, version ${previous} → ${current}`)
