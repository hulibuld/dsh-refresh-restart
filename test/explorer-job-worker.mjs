// Test-only: no DSH helper, dispatch, exit, or process termination.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { handOff } from '../lib/win.js'

// node --test discovers .mjs files in test/ too; discovery must be inert.
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
      // Actual production handOff and unchanged generated Explorer broker script.
      // The test-only entry wrapper only arms its OWN self-exit deadline before
      // forwarding the original parameters. Disable spawnSync's kill-on-timeout.
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
