// 仅供测试使用：不调用 DSH 助手、交接或退出流程，也不终止进程。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { handOff } from '../lib/win.js'

// node --test 也会发现 test/ 下的 .mjs 文件；发现文件时必须不执行任何操作。
if (process.argv.length === 5) {
  const [dir, token, writer] = process.argv.slice(2)
  const deadline = Date.now() + 15000
  const gateDeadline = Date.now() + 5000
  const finish = join(dir, 'finish')
  const save = (name, data) => writeFileSync(join(dir, name), JSON.stringify(data), 'utf8')
  try {
    save('ready.json', { pid: process.pid, execPath: process.execPath, token })
    while (!existsSync(join(dir, 'gate')) && !existsSync(finish) && Date.now() < gateDeadline) await delay(30)
    if (existsSync(finish) || !existsSync(join(dir, 'gate'))) throw new Error('Gate not opened before worker deadline')
    const result = handOff({ helperPath: writer, payloadPath: join(dir, 'payload.json'),
      scriptPath: join(dir, 'handoff.ps1'), workDir: dir,
      // 使用真实生产 handOff 和未经修改的生成式 Explorer 代理脚本。
      // 测试专用入口包装器只设置自身的退出截止时间，随后
      // 转发原始参数。禁用 spawnSync 的超时终止机制。
      run: (exe, args, options) => spawnSync(exe, [
        ...args.slice(0, 4), fileURLToPath(new URL('explorer-job-launcher.ps1', import.meta.url)),
        ...args.slice(5), '-HandOffScript', args[4],
      ], { ...options, timeout: 0 }),
    })
    save('handoff.json', result)
    if (!result.ok) throw new Error(result.warning)
    while (!existsSync(join(dir, 'boot.json')) && !existsSync(finish) && Date.now() < deadline) await delay(30)
    const receipt = JSON.parse(readFileSync(join(dir, 'boot.json'), 'utf8'))
    save('receipt.json', { pid: receipt.pid, token })
    while (!existsSync(finish) && Date.now() < deadline) await delay(30)
  } catch (error) {
    save('worker-error.json', { error: error.message })
    process.exitCode = 1
  } finally {
    save('worker-done.json', { pid: process.pid, token })
  }
}
