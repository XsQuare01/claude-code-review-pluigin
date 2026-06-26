#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Install this repo's NEW review-rules and skills into the live ~/.claude
    install that Claude Code actually loads.

.DESCRIPTION
    This plugin runs as direct copies under ~/.claude (it is NOT loaded via the
    plugin marketplace), so a new skill/rule added in this repo does not appear
    in Claude Code until it is copied to the live locations:

        review-rules/*.md   ->  ~/.claude/review-rules/
        skills/<name>/**    ->  ~/.claude/skills/<name>/

    SAFE BY DEFAULT — add-only. The live install is treated as the source of
    truth for files that already exist there (it carries local customizations
    that are intentionally ahead of this repo). This script therefore:

        * copies a file ONLY when it does not yet exist in the destination
        * NEVER overwrites a file that already exists in the destination
          (even when its content differs) unless you pass -Force
        * never deletes anything

    After syncing, restart your Claude Code session so newly added skills are
    picked up.

.PARAMETER DryRun
    Show what would change without writing anything.

.PARAMETER Force
    Also overwrite destination files that already exist but differ. Use only
    when you deliberately want to push repo edits over the live versions —
    this can clobber live-only customizations. Always preview with -DryRun
    -Force first.

.EXAMPLE
    powershell ./scripts/sync-to-claude.ps1 -DryRun        # preview (add-only)
    powershell ./scripts/sync-to-claude.ps1                # install new files
    powershell ./scripts/sync-to-claude.ps1 -DryRun -Force # preview overwrites
#>
param(
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Repo root = parent of this scripts/ directory
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Dest     = Join-Path $HOME '.claude'

$ruleSrc  = Join-Path $RepoRoot 'review-rules'
$skillSrc = Join-Path $RepoRoot 'skills'
$ruleDst  = Join-Path $Dest     'review-rules'
$skillDst = Join-Path $Dest     'skills'

if (-not (Test-Path $ruleSrc))  { throw "review-rules not found at $ruleSrc" }
if (-not (Test-Path $skillSrc)) { throw "skills not found at $skillSrc" }

$tag  = if ($DryRun) { '[dry-run] ' } else { '' }
$mode = if ($Force)  { 'add + overwrite (-Force)' } else { 'add-only (safe)' }
Write-Host "${tag}Sync ($mode): $RepoRoot  ->  $Dest" -ForegroundColor Cyan

$added = 0; $overwritten = 0; $skipped = 0; $same = 0

# Decide what to do for one src->dst pair (no writes here).
#   'new'      : dst missing             -> always copy
#   'differs'  : dst exists & differs     -> copy only with -Force, else skip
#   'same'     : dst exists & identical   -> nothing
function Get-SyncState($src, $dst) {
    if (-not (Test-Path $dst)) { return 'new' }
    $a = (Get-FileHash -Algorithm SHA256 -LiteralPath $src).Hash
    $b = (Get-FileHash -Algorithm SHA256 -LiteralPath $dst).Hash
    if ($a -ne $b) { return 'differs' } else { return 'same' }
}

function Sync-One($src, $dst, $rel) {
    $state = Get-SyncState $src $dst
    $willCopy = $false
    switch ($state) {
        'new' {
            $script:added++; $willCopy = $true
            Write-Host "  + $rel" -ForegroundColor Green
        }
        'differs' {
            if ($Force) {
                $script:overwritten++; $willCopy = $true
                Write-Host "  ! $rel (overwrite)" -ForegroundColor Red
            } else {
                $script:skipped++
                Write-Host "  = $rel (exists, differs - kept live)" -ForegroundColor DarkYellow
            }
        }
        'same' { $script:same++ }
    }
    if ($willCopy -and -not $DryRun) {
        $dstDir = Split-Path -Parent $dst
        if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
        Copy-Item -LiteralPath $src -Destination $dst -Force
    }
}

# 1) review-rules/*.md
foreach ($f in Get-ChildItem -Path $ruleSrc -Filter '*.md' -File) {
    Sync-One $f.FullName (Join-Path $ruleDst $f.Name) "review-rules/$($f.Name)"
}

# 2) skills/<name>/** (every file under each skill directory)
foreach ($dir in Get-ChildItem -Path $skillSrc -Directory) {
    foreach ($f in Get-ChildItem -Path $dir.FullName -File -Recurse) {
        $rel = $f.FullName.Substring($skillSrc.Length).TrimStart('\','/')
        Sync-One $f.FullName (Join-Path $skillDst $rel) ("skills/" + ($rel -replace '\\','/'))
    }
}

Write-Host ("${tag}Done. added=$added overwritten=$overwritten kept-live=$skipped unchanged=$same") -ForegroundColor Cyan
if (-not $Force -and $skipped -gt 0) {
    Write-Host "$skipped file(s) differ but were kept (live is source of truth). Use -Force to overwrite." -ForegroundColor DarkGray
}
if (($added + $overwritten) -gt 0) {
    if ($DryRun) { Write-Host "Run without -DryRun to apply, then restart Claude Code." -ForegroundColor DarkGray }
    else         { Write-Host "Restart your Claude Code session to load newly added skills." -ForegroundColor DarkGray }
}
