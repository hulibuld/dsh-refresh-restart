/**
 * 通过已运行的 Explorer 桌面的 Shell.Application 交接 Windows 助手。
 * DSH 的分离子进程仍可能属于关闭时终止成员的 Job，禁止使用
 * 直接派生进程作为回退。启动回执只能证明启动，不能证明脱离 Job 后仍存活。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const WIN_HELPER_PATH = join(here, 'win-helper.ps1')
export const POWERSHELL = 'pwsh.exe'

/** 商店应用执行别名是重解析点，existsSync 可能返回 false。 */
function executableExists(path) {
  if (existsSync(path)) return true
  try { lstatSync(path); return true } catch { return false }
}

/** 不静默回退到 5.1；必须显式启用兼容模式。 */
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

/** 为调用方保留旧导出名称，实际不创建快捷方式。 */
export function shortcutScript() {
  return [
    'param(',
    '  [Parameter(Mandatory = $true)][string]$TargetPath,',
    '  [Parameter(Mandatory = $true)][string]$Arguments,',
    '  [Parameter(Mandatory = $true)][string]$WorkingDirectory',
    ')',
    "$ErrorActionPreference = 'Stop'",
    '# ShellWindows 连接已存在的外壳窗口，不新建 Shell.Application。',
    "$type = [type]::GetTypeFromCLSID([guid]'9BA05972-F6A8-11CF-A442-00A0C90A8F39')",
    '$windows = $null; $desktop = $null; $document = $null; $application = $null',
    'try {',
    '  $windows = [Activator]::CreateInstance($type)',
    '  $location = 0; $root = 0; $hwnd = 0',
    '  # SWC_DESKTOP = 8、SWFO_NEEDDISPATCH = 1；找不到现有桌面时失败。',
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

/** 按 Windows 参数规则转义，不经过命令解释器，也不插值 PowerShell 源码。 */
function quoteArgument(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('Invalid hand-off path')
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

export function helperArguments(helperPath, payloadPath) {
  return `-NoProfile -NonInteractive -File ${quoteArgument(helperPath)} -PayloadFile ${quoteArgument(payloadPath)}`
}

/** 此处成功仅表示 ShellExecute 已返回；dispatchWin 仍须检查启动回执。 */
export function handOff({ helperPath, payloadPath, scriptPath, workDir = tmpdir(), logger = () => {},
  allowWindowsPowerShell = false, run = spawnSync, env = process.env, exists = executableExists }) {
  try {
    const target = powershellPath(env, exists, { allowWindowsPowerShell })
    if (target.toLowerCase().endsWith('powershell.exe')) {
      logger('Explicit Windows PowerShell 5.1 compatibility enabled; unsigned scripts may be blocked by execution policy.')
    }
    const args = helperArguments(helperPath, payloadPath)
    // 中文注释需要 UTF-8 BOM，避免显式使用 5.1 兼容模式时按 ANSI 解码。
    writeFileSync(scriptPath, '\uFEFF' + shortcutScript(), 'utf8')
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

/** 仅检查启动回执，不能据此证明宿主 Job 关闭后助手仍存活。 */
export function waitBoot(bootPath, { timeoutMs = 8000, stepMs = 120 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(bootPath)) {
      try {
        const parsed = JSON.parse(readFileSync(bootPath, 'utf8'))
        if (parsed && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) return parsed
      } catch {
        // 状态尚未写完时稍后重试。
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs)
  }
  return null
}

/** 只展示属于本次请求的失败，不使用旧状态。 */
export function readStartupFailure({ statePath, requestId }) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    if (state.requestId === requestId && state.phase === 'quit-failed' && typeof state.detail === 'string' && state.detail !== '') {
      return state.detail.slice(0, 1000)
    }
  } catch { /* 状态缺失或未写完不代表助手已失败。 */ }
  return null
}

/** 失败即停止：写入参数、通过现有桌面的 ShellExecute 交接、检查启动回执。 */
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
