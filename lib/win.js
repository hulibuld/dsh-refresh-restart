/**
 * Windows 交付助手（hand-off）。
 *
 * 为什么 Windows 不能像 macOS / Linux 那样直接 `spawn(..., {detached: true})`：
 * 桌面版 DSH 的主进程是 Chromium 起的，整个进程树都在一个带
 * kill-on-close 的 job object 里。从树里 spawn 出来的助手会跟着应用一起被
 * job 回收 —— 于是它只能把应用关掉，永远没机会把应用拉回来（0.2.2 的真实
 * 症状：点重启，窗口关了，然后再也不开）。Explorer 在 job object 之外，由它
 * 启动的进程才能活过这次关停。
 *
 * 所以这里的做法是：写一个 .lnk 快捷方式（目标 = powershell.exe + 助手脚本），
 * 让 explorer.exe 去执行它，然后等助手写的 boot 标记确认交接成功。
 *
 * @module dsh-refresh-restart/lib/win
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 助手脚本的位置（随包发布，只读）。 */
const here = dirname(fileURLToPath(import.meta.url))
export const WIN_HELPER_PATH = join(here, 'win-helper.ps1')

/**
 * PowerShell 的绝对路径。
 *
 * 快捷方式里的 TargetPath 必须写全路径：只写 `powershell.exe` 的话，Windows
 * 会按快捷方式的工作目录去找，找不到就什么都不发生 —— 助手根本没起来。
 */
export function powershellPath(env = process.env, exists = existsSync) {
  const root = typeof env.SystemRoot === 'string' && env.SystemRoot !== '' ? env.SystemRoot : 'C:\\Windows'
  const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return exists(candidate) ? candidate : 'powershell.exe'
}

/** PowerShell 可执行文件（兜底值，真实路径见 powershellPath）。 */
export const POWERSHELL = 'powershell.exe'

/** 读助手源码。测试和打包都用得到。 */
export function winHelperSource() {
  return readFileSync(WIN_HELPER_PATH, 'utf8')
}

/** 助手需要的载荷。字段名要和 win-helper.ps1 里读的一致。 */
export function buildPayload(plan, { payloadPath, bootPath }) {
  return {
    exe: plan.appPath,
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

/** PowerShell 单引号字符串：内部的单引号写两遍。 */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * 生成「创建快捷方式」的 PowerShell 脚本。
 *
 * 单独写成脚本文件而不是 `-Command`：路径里带空格、引号、中文都很常见，
 * 参数化传入（-File + 具名参数）比在命令行里拼字符串安全得多。
 */
export function shortcutScript() {
  // ASCII only：Windows PowerShell 5.1 用 ANSI 解码无 BOM 的 UTF-8 脚本。
  return [
    'param(',
    '  [Parameter(Mandatory = $true)][string]$LnkPath,',
    '  [string]$TargetPath,',
    '  [string]$Arguments,',
    '  [string]$WorkingDirectory,',
    '  [int]$WindowStyle = 7',
    ')',
    "$ErrorActionPreference = 'Stop'",
    '$shell = New-Object -ComObject WScript.Shell',
    '$shortcut = $shell.CreateShortcut($LnkPath)',
    '$shortcut.TargetPath = $TargetPath',
    "if (-not [string]::IsNullOrEmpty($Arguments)) { $shortcut.Arguments = $Arguments }",
    "if (-not [string]::IsNullOrEmpty($WorkingDirectory)) { $shortcut.WorkingDirectory = $WorkingDirectory }",
    '$shortcut.WindowStyle = $WindowStyle',
    '$shortcut.Save()',
    '',
  ].join('\r\n')
}

/** 助手交给 PowerShell 的参数行（不含 powershell.exe 本身）。 */
export function helperArguments(helperPath, payloadPath) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    `"${helperPath}"`,
    '-PayloadFile',
    `"${payloadPath}"`,
  ].join(' ')
}

/**
 * 建好快捷方式并让 explorer 执行它。
 *
 * @returns {{ ok: boolean, mode: string, warning?: string }}
 */
export function handOff({ helperPath, payloadPath, lnkPath, scriptPath, workDir = tmpdir(), logger = () => {} }) {
  writeFileSync(scriptPath, shortcutScript(), 'utf8')
  const created = spawnSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      '-LnkPath', lnkPath,
      '-TargetPath', powershellPath(),
      '-Arguments', helperArguments(helperPath, payloadPath),
      '-WorkingDirectory', workDir],
    { encoding: 'utf8', timeout: 20000, windowsHide: true },
  )
  if (created.status !== 0) {
    const detail = (created.stderr || created.stdout || '').trim() || `exit ${created.status}`
    logger(`建快捷方式失败：${detail}`)
    return { ok: false, mode: 'shortcut-failed', warning: detail }
  }

  // explorer.exe 执行 .lnk = 由 job object 之外的 shell 创建进程。
  const started = spawn('explorer.exe', [lnkPath], { detached: true, stdio: 'ignore', windowsHide: true })
  started.unref()
  return { ok: true, mode: 'explorer' }
}

/** 等助手报到（写 boot 文件），确认这次交接真的发生了。 */
export function waitBoot(bootPath, { timeoutMs = 8000, stepMs = 120 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(bootPath)) {
      try {
        const parsed = JSON.parse(readFileSync(bootPath, 'utf8'))
        if (parsed !== null && typeof parsed === 'object') return parsed
      } catch {
        // 文件刚建还没写完，下一轮再读
      }
    }
    sleep(stepMs)
  }
  return null
}

/** 同步睡：助手是一次性脚本，没有并发需求。 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Windows 上完整交付一次：载荷 → 快捷方式 → explorer → 等报到。
 * 每一层失败都退到下一层，最后的兜底是直接 spawn（可能被 job 回收，但总比不动强）。
 */
export function dispatchWin({ plan, stamp, logger = () => {} }) {
  const payloadPath = join(tmpdir(), `dsh-refresh-restart-${stamp}.payload.json`)
  const bootPath = join(tmpdir(), `dsh-refresh-restart-${stamp}.boot.json`)
  const lnkPath = join(tmpdir(), `dsh-refresh-restart-${stamp}.lnk`)
  const scriptPath = join(tmpdir(), `dsh-refresh-restart-${stamp}-shortcut.ps1`)
  const payload = buildPayload(plan, { payloadPath, bootPath })

  try {
    writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf8')
  } catch (error) {
    return { ok: false, error: `写载荷失败：${error.message}` }
  }

  const hand = handOff({ helperPath: WIN_HELPER_PATH, payloadPath, lnkPath, scriptPath, logger })
  if (hand.ok) {
    const boot = waitBoot(bootPath)
    if (boot !== null) {
      logger(`助手已报到：pid ${boot.pid}（经 explorer 交接）`)
      return { ok: true, mode: hand.mode, helperPid: Number(boot.pid) || 0, payloadPath, lnkPath, bootPath }
    }
    logger('助手没有在 8 秒内报到，退回直接 spawn')
  }

  // 兜底：直接拉起 powershell。它在 job object 里，可能被一起回收，所以只当最后手段。
  try {
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN_HELPER_PATH, '-PayloadFile', payloadPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    const boot = waitBoot(bootPath, { timeoutMs: 6000 })
    logger(`兜底 spawn 已发出：pid ${child.pid}，报到=${boot === null ? '无' : '有'}`)
    if (boot === null) {
      // 两条路都没能让助手报到：不假装成功，让界面如实报错，用户才知道要手动重开。
      return {
        ok: false,
        mode: 'failed',
        error: hand.warning
          ? `交接失败（${hand.warning}），直接拉起也没能启动助手`
          : '助手没有启动：可能被安全软件拦下了',
      }
    }
    return {
      ok: true,
      mode: 'direct-fallback',
      helperPid: Number(boot.pid) || 0,
      payloadPath,
      lnkPath,
      bootPath,
      warning: hand.warning || 'explorer 交接未确认，退回直接 spawn（可能随应用一起被 job 回收）',
    }
  } catch (error) {
    return { ok: false, error: `拉起助手失败：${error.message}` }
  }
}
