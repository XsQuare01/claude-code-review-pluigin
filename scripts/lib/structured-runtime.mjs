import { parseStructuredProducerResponse } from './review-result-contract.mjs'

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : value
}

function normalizePath(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '')
}

function freezeClone(value) {
  const cloned = cloneJson(value)
  return deepFreeze(cloned)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) deepFreeze(nested)
  return value
}

function formatDiagnostics(error) {
  const message = String(error?.message ?? error)
  return message.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 4).join('; ')
}

function mergeUnique(items) {
  return [...new Set(items)]
}

function findingMergeKey(finding) {
  const location = finding.location ?? {}
  if (!['verified', 'deleted'].includes(location.kind)) return null
  const anchor = location.kind === 'verified' ? location.line : location.lineBefore
  return JSON.stringify([
    finding.ruleId,
    location.kind,
    normalizePath(location.path),
    anchor,
    location.endLine ?? null,
    normalizeText(location.quote),
    finding.impact,
    finding.category ?? null,
    finding.confidence,
    normalizeText(finding.title),
    normalizeText(finding.body),
  ])
}

function createFrozenFinding(finding, sourceLabel) {
  return freezeClone({ ...finding, sourceLabels: [sourceLabel] })
}

function createFrozenOpenQuestion(item, sourceLabel) {
  return freezeClone({ ...item, sourceLabels: [sourceLabel] })
}

export function createPassState({ sourceLabel, manifest }) {
  return Object.freeze({
    sourceLabel,
    manifest,
    attempts: 0,
    status: 'pending',
    result: null,
    failureKind: null,
    diagnosticsHistory: Object.freeze([]),
  })
}

export function consumeProducerResponse(state, raw) {
  if (state.status === 'accepted' || state.status === 'failed') throw new Error('E_PASS_TERMINAL: terminal pass state cannot consume additional responses')
  try {
    const parsed = parseStructuredProducerResponse(raw, state.manifest)
    const next = Object.freeze({
      ...state,
      attempts: state.attempts + 1,
      status: 'accepted',
      result: freezeClone(parsed),
    })
    return { status: 'accepted', pass: next }
  } catch (error) {
    const diagnostics = formatDiagnostics(error)
    const nextState = {
      ...state,
      attempts: state.attempts + 1,
      diagnosticsHistory: Object.freeze([...state.diagnosticsHistory, diagnostics]),
      result: null,
    }
    if (state.attempts === 0) {
      const retryPass = Object.freeze({ ...nextState, status: 'retrying', failureKind: null })
      return { status: 'retry', diagnostics, pass: retryPass }
    }
    const failedPass = Object.freeze({ ...nextState, status: 'failed', failureKind: 'malformed-output' })
    return { status: 'failed', diagnostics, pass: failedPass }
  }
}

export function aggregatePasses(passes) {
  const mergedFindings = []
  const findingIndex = new Map()
  const openQuestions = []
  const failedPasses = []
  const acceptedPasses = []

  for (const pass of passes) {
    if (pass.status === 'pending' || pass.status === 'retrying') {
      throw new Error('E_PASS_NONTERMINAL: aggregatePasses requires terminal pass states')
    }
    const accepted = pass.status === 'accepted' && pass.result && typeof pass.result === 'object' && !Array.isArray(pass.result)
    const failed = pass.status === 'failed'
      && typeof pass.failureKind === 'string'
      && pass.failureKind.trim() !== ''
      && pass.result == null
    if (!accepted && !failed) {
      throw new Error('E_PASS_INVALID_STATE: aggregatePasses received an invalid terminal pass state')
    }
    if (accepted) {
      acceptedPasses.push(freezeClone({ sourceLabel: pass.sourceLabel, status: pass.status }))
      for (const finding of pass.result.findings ?? []) {
        const key = findingMergeKey(finding)
        if (!key) {
          mergedFindings.push(createFrozenFinding(finding, pass.sourceLabel))
          continue
        }
        const existingIndex = findingIndex.get(key)
        if (existingIndex === undefined) {
          findingIndex.set(key, mergedFindings.length)
          mergedFindings.push(createFrozenFinding(finding, pass.sourceLabel))
          continue
        }
        const existing = mergedFindings[existingIndex]
        mergedFindings[existingIndex] = freezeClone({ ...existing, sourceLabels: mergeUnique([...existing.sourceLabels, pass.sourceLabel]) })
      }
      for (const item of pass.result.openQuestions ?? []) openQuestions.push(createFrozenOpenQuestion(item, pass.sourceLabel))
      continue
    }
    failedPasses.push(freezeClone({ sourceLabel: pass.sourceLabel, status: pass.status, failureKind: pass.failureKind }))
  }

  return freezeClone({ findings: mergedFindings, openQuestions, failedPasses, acceptedPasses })
}

export function deriveSeverity(axes) {
  const impact = axes?.impact
  const confidence = axes?.confidence
  if (!impact || !confidence || !['high', 'low'].includes(impact) || !['high', 'low'].includes(confidence)) {
    throw new Error('E_INVALID_SEVERITY_AXES: deriveSeverity requires impact/confidence high|low axes')
  }
  if (impact === 'high' && confidence === 'high') return '🔴'
  if (impact === 'low' && confidence === 'low') return '🔵'
  return '🟡'
}

function escapeProse(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^ {4,}/gm, spaces => `&#32;${spaces.slice(1)}`)
    .replace(/\bhttps?:\/\//g, match => match.replace(':', '&#58;'))
    .replace(/\bwww\./g, 'www&#46;')
    .replace(/\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1&#64;$2')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/^( {0,3})([#>|*+-])/gm, '$1\\$2')
    .replace(/^( {0,3})(\d{1,9})([.)])(?=[ \t]|$)/gm, '$1$2\\$3')
    .replace(/^( {0,3})(```|~~~)/gm, '$1\\$2')
    .replace(/^( {0,3})\|/gm, '$1\\|')
    .replace(/^( {0,3})(=+|-+)$/gm, '$1\\$2')
}

function renderCode(value) {
  const text = String(value)
  const longestRun = Math.max(0, ...((text.match(/`+/g)) ?? []).map(run => run.length))
  const ticks = '`'.repeat(Math.max(1, longestRun + 1))
  return `${ticks}${text}${ticks}`
}

function formatLocation(location) {
  if (location.kind === 'verified') {
    const end = Number.isInteger(location.endLine) ? `-${location.endLine}` : ''
    return `${renderCode(`${normalizePath(location.path)}:${location.line}${end}`)} — ${renderCode(location.quote)}`
  }
  if (location.kind === 'deleted') {
    const end = Number.isInteger(location.endLine) ? `-${location.endLine}` : ''
    return `${renderCode(`${normalizePath(location.path)}:${location.lineBefore}${end}`)} — ${renderCode(location.quote)}`
  }
  return null
}

function renderSlots(item, manifest, kind) {
  const labels = manifest.renderingSafety.slotLabels
  const lines = []
  for (const slot of manifest.renderingSafety.slotOrder) {
    if (slot === 'evidence' && !item.evidence) continue
    if (slot === 'recommendation' && !item.recommendation) continue
    if (slot === 'body' && !item.body) continue
    if (slot === 'findingConfidenceReason' && !(kind === 'finding' && item.confidence === 'low' && item.reason)) continue
    if (slot === 'locationUnverifiedReason' && !(item.location?.kind === 'unverified' && item.location?.reason)) continue
    if (slot === 'openQuestionReason' && !(kind === 'openQuestion' && item.reason)) continue
    let value = null
    if (slot === 'body') value = item.body
    else if (slot === 'evidence') value = item.evidence
    else if (slot === 'recommendation') value = item.recommendation
    else if (slot === 'findingConfidenceReason') value = item.reason
    else if (slot === 'locationUnverifiedReason') value = item.location.reason
    else if (slot === 'openQuestionReason') value = item.reason
    if (value) lines.push(`${labels[slot]}: ${escapeProse(value)}`)
  }
  return lines
}

function renderFinding(finding, manifest) {
  const lines = []
  lines.push(`#### ${deriveSeverity(finding)} \`${finding.ruleId}\` ${escapeProse(finding.title)}`)
  lines.push(`영향: ${finding.impact === 'high' ? '높음' : '낮음'} · 확신: ${finding.confidence === 'high' ? '높음' : '낮음'}`)
  const locationLine = formatLocation(finding.location)
  if (locationLine) lines.push(locationLine)
  lines.push(...renderSlots(finding, manifest, 'finding'))
  if (Array.isArray(finding.sourceLabels) && finding.sourceLabels.length > 0) lines.push(`출처: ${finding.sourceLabels.map(label => renderCode(label)).join(', ')}`)
  return lines.join('\n')
}

function renderOpenQuestion(item, manifest) {
  const lines = []
  lines.push(`#### ${escapeProse(item.title)}`)
  const locationLine = formatLocation(item.location)
  if (locationLine) lines.push(locationLine)
  lines.push(...renderSlots(item, manifest, 'openQuestion'))
  if (Array.isArray(item.sourceLabels) && item.sourceLabels.length > 0) lines.push(`출처: ${item.sourceLabels.map(label => renderCode(label)).join(', ')}`)
  return lines.join('\n')
}

export function renderStructuredSections(aggregated, manifest) {
  return {
    findings: (aggregated.findings ?? []).map(finding => renderFinding(finding, manifest)).join('\n\n'),
    openQuestions: (aggregated.openQuestions ?? []).map(item => renderOpenQuestion(item, manifest)).join('\n\n'),
  }
}
