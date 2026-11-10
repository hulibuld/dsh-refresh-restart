import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { powershellPath } from '../lib/win.js'

const fixture = (name) => fileURLToPath(new URL(name, import.meta.url))

// Explicit opt-in: only a newly spawned harmless worker is assigned to an
// anonymous Job with default limits (NO kill-on-close). No DSH quit is invoked.
test('real Explorer handOff escapes one dedicated test Job, not necessarily ALL Jobs', {
  skip: process.platform !== 'win32' || process.env.DSH_TEST_EXPLORER_JOB !== '1',
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh specific job 中文 O'Brien "))
  const token = randomUUID()
  try {
    writeFileSync(join(dir, 'payload.json'), JSON.stringify({ token,
      bootPath: join(dir, 'boot.json'), finishPath: join(dir, 'finish'), donePath: join(dir, 'writer-done.json'),
    }), 'utf8')
    const child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-File',
      fixture('explorer-job-controller.ps1'), '-NodePath', process.execPath,
      '-WorkerPath', fixture('explorer-job-worker.mjs'), '-WriterPath', fixture('explorer-job-writer.ps1'),
      '-Directory', dir, '-Token', token], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    // No child_process timeout/kill: controller and fixtures finish themselves.
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    t.diagnostic(`Dedicated test Job controller: ${stdout.trim()}; stderr=${stderr.trim()}`)
    assert.equal(code, 0, `Cannot prove specific-Job separation: ${stderr || stdout}`)
    const evidence = JSON.parse(stdout.trim())
    assert.equal(evidence.ok, true)
    assert.equal(evidence.workerSpecificJob, true)
    assert.equal(evidence.writerSpecificJob, false)
    assert.equal(evidence.workerExited, true, 'Worker must exit naturally after finish')
    assert.equal(evidence.writerExited, true, 'Writer must exit naturally after finish')
    assert.equal(evidence.survivalTested, false)
    assert.equal(typeof evidence.writerAnyJob, 'boolean') // diagnostic, NOT a gate
    assert.ok(!readdirSync(dir).some((name) => name.toLowerCase().endsWith('.lnk')))
    t.diagnostic('Verified only: worker belongs to this dedicated anonymous Job; real Explorer writer does not. ANY Job membership is diagnostic. No specific DSH Job queried, no real DSH exit/survival tested, no processes terminated.')
  } finally {
    writeFileSync(join(dir, 'finish'), token, 'utf8')
    // Normally both children already exited; retries allow their last file closes.
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
