/**
 * Windows hand-off through the existing Explorer desktop's Shell.Application.
 * A detached child of DSH can still belong to its kill-on-close job; never use
 * direct spawn as a fallback. A boot receipt proves startup, NOT job survival.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const WIN_HELPER_PATH = join(here, 'win-helper.ps1')
export const POWERSHELL = 'pwsh.exe'

/** Store App Execution Aliases are reparse points: existsSync can return false. */
function executableExists(path) {
  if (existsSync(path)) return true
  try { lstatSync(path); return true } catch { return false }
}

/** No silent 5.1 fallback. Compatibility must be explicitly requested. */
export function powershellPath(env = process.env, exists = executableExists, { allowWindowsPowerShell = false } = {}) {
  const candidates = [
    env.ProgramW6432 && join(env.ProgramW6432, 'PowerShell', '7', POWERSHELL),
    join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', POWERSHELL),
    ...(env.PATH || env.Path || '').split(delimiter).filter(Boolean).map((dir) => join(dir, POWERSHELL)),
  ].filter(Boolean)
  const found = candidates.find((candidate) => exists(candidate))
  if (found) return found
  if (allowWindowsPowerShell) {
    const legacy = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (exists(legacy)) return legacy
  }
  throw new Error('PowerShell 7 (pwsh.exe) not found; install it or explicitly opt into Windows PowerShell 5.1 compatibility. Execution policy is not bypassed.')
}

export function winHelperSource() {
  return readFileSync(WIN_HELPER_PATH, 'utf8')
}

export function buildPayload(plan, { payloadPath, bootPath }) {
  return {
    exe: plan.appPath,
    requestId: plan.requestId,
    hostPid: plan.hostPid,
    imageName: plan.imageName,
    logPath: plan.logPath,
    statePath: plan.statePath,
    bootPath,
    quitTimeoutMs: plan.quitTimeoutMs,
    openDelayMs: plan.openDelayMs,
    forceKill: plan.forceKill === true,
    payloadPath,
  }
}

export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Kept under the old export name for callers; creates NO shortcut. */
export function shortcutScript() {
  return [
    'param(',
    '  [Parameter(Mandatory = $true)][string]$TargetPath,',
    '  [Parameter(Mandatory = $true)][string]$Arguments,',
    '  [Parameter(Mandatory = $true)][string]$WorkingDirectory',
    ')',
    "$ErrorActionPreference = 'Stop'",
    '# ShellWindows is a broker to EXISTING shell windows, not a new Shell.Application.',
    "$type = [type]::GetTypeFromCLSID([guid]'9BA05972-F6A8-11CF-A442-00A0C90A8F39')",
    '$windows = $null; $desktop = $null; $document = $null; $application = $null',
    'try {',
    '  $windows = [Activator]::CreateInstance($type)',
    '  $location = 0; $root = 0; $hwnd = 0',
    '  # SWC_DESKTOP = 8, SWFO_NEEDDISPATCH = 1. Fail if no existing desktop.',
    '  $desktop = $windows.FindWindowSW([ref]$location, [ref]$root, 8, [ref]$hwnd, 1)',
    "  if ($null -eq $desktop -or $hwnd -eq 0) { throw 'Existing Explorer desktop unavailable' }",
    '  $document = $desktop.Document',
    '  $application = $document.Application',
    "  if ($null -eq $application) { throw 'Existing desktop Shell.Application unavailable' }",
    "  $application.ShellExecute($TargetPath, $Arguments, $WorkingDirectory, 'open', 0)",
    '} finally {',
    '  foreach ($com in @($application, $document, $desktop, $windows)) {',
    '    if ($null -ne $com -and [Runtime.InteropServices.Marshal]::IsComObject($com)) {',
    '      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($com)',
    '    }',
    '  }',
    '}',
    '',
  ].join('\r\n')
}

/** Windows argv quoting; no command interpreter or PowerShell source interpolation. */
function quoteArgument(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('Invalid hand-off path')
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

export function helperArguments(helperPath, payloadPath) {
  return `-NoProfile -NonInteractive -File ${quoteArgument(helperPath)} -PayloadFile ${quoteArgument(payloadPath)}`
}

/** Success here means ShellExecute returned; dispatchWin still requires a boot. */
export function handOff({ helperPath, payloadPath, scriptPath, workDir = tmpdir(), logger = () => {},
  allowWindowsPowerShell = false, run = spawnSync, env = process.env, exists = executableExists }) {
  try {
    const target = powershellPath(env, exists, { allowWindowsPowerShell })
    if (target.toLowerCase().endsWith('powershell.exe')) {
      logger('Explicit Windows PowerShell 5.1 compatibility enabled; unsigned scripts may be blocked by execution policy.')
    }
    const args = helperArguments(helperPath, payloadPath)
    writeFileSync(scriptPath, shortcutScript(), 'utf8')
    const result = run(target,
      ['-NoProfile', '-NonInteractive', '-STA', '-File', scriptPath,
        '-TargetPath', target, `-Arguments:${args}`, '-WorkingDirectory', workDir],
      { encoding: 'utf8', timeout: 20000, windowsHide: true })
    if (result.error || result.status !== 0) {
      throw new Error(result.error?.message || (result.stderr || result.stdout || '').trim() || `exit ${result.status}`)
    }
    return { ok: true, mode: 'explorer-shell' }
  } catch (error) {
    const warning = `Existing Explorer hand-off failed (execution policy is unchanged): ${error.message}`
    logger(warning)
    return { ok: false, mode: 'handoff-failed', warning }
  }
}

/** Startup receipt only. It cannot prove survival of closing the host's job. */
export function waitBoot(bootPath, { timeoutMs = 8000, stepMs = 120 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(bootPath)) {
      try {
        const parsed = JSON.parse(readFileSync(bootPath, 'utf8'))
        if (parsed && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) return parsed
      } catch {
        // An incomplete write is retried.
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs)
  }
  return null
}

/** Only surface a failure belonging to this attempt, never an older state. */
export function readStartupFailure({ statePath, requestId }) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    if (state.requestId === requestId && state.phase === 'quit-failed' && typeof state.detail === 'string' && state.detail !== '') {
      return state.detail.slice(0, 1000)
    }
  } catch { /* Missing or partial state is not proof of a helper failure. */ }
  return null
}

/** Fail closed: payload -> existing desktop ShellExecute -> startup receipt. */
export function dispatchWin({ plan, stamp, logger = () => {}, allowWindowsPowerShell = false }) {
  const payloadPath = join(tmpdir(), `dsh-refresh-restart-${stamp}.payload.json`)
  const bootPath = join(tmpdir(), `dsh-refresh-restart-${stamp}.boot.json`)
  const scriptPath = join(tmpdir(), `dsh-refresh-restart-${stamp}-handoff.ps1`)
  try {
    if (existsSync(bootPath)) throw new Error('Boot receipt already exists; refusing a stale receipt')
    writeFileSync(payloadPath, JSON.stringify(buildPayload(plan, { payloadPath, bootPath }), null, 2), 'utf8')
    const hand = handOff({ helperPath: WIN_HELPER_PATH, payloadPath, scriptPath, logger, allowWindowsPowerShell })
    if (!hand.ok) return { ok: false, mode: hand.mode, error: hand.warning }
    const boot = waitBoot(bootPath)
    if (boot === null) {
      const failure = readStartupFailure(plan)
      return { ok: false, mode: 'boot-unconfirmed', error: failure
        ? `Windows 助手初始化失败：${failure}；未请求退出，也未使用直接启动回退。`
        : '8 秒内未确认 Windows 助手就绪，已停止操作，未使用直接启动回退。仅凭此超时无法判断是否被安全软件拦截。' }
    }
    logger(`Explorer helper started: pid ${boot.pid}; startup receipt does not prove job survival`)
    return { ok: true, mode: hand.mode, helperPid: boot.pid, payloadPath, bootPath }
  } catch (error) {
    return { ok: false, mode: 'failed', error: `Windows hand-off failed: ${error.message}` }
  }
}
