import type { StatPathFn } from '../../helper/index'
import { ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  assertSafeKernelPaths,
  createPrivilegedKernel,
  resolveHelperSecret,
} from '../../helper/index'

// Use the real event emitter shape without launching a process.
function fakeProc(): ChildProcess {
  const proc = new ChildProcess()
  proc.kill = vi.fn(() => {
    Object.assign(proc, { killed: true })
    queueMicrotask(() => proc.emit('exit', null, 'SIGTERM'))
    return true
  })
  queueMicrotask(() => proc.emit('spawn'))
  return proc
}

const GOOD = {
  binaryPath: '/opt/app/resources/mihomo',
  homeDir: '/home/user/.config/mcxd',
  configPath: '/home/user/.config/mcxd/config.yaml',
}

// A regular, non-group/world-writable file (0o755).
const okStat: StatPathFn = () => ({ isFile: true, mode: 0o755 })

describe('createPrivilegedKernel.start — spawn-path validation', () => {
  it('spawns mihomo with -d/-f when the paths are valid', async () => {
    const spawn = vi.fn(() => fakeProc())
    const kernel = createPrivilegedKernel({
      spawn,
      statPath: okStat,
      platform: 'linux',
    })
    const res = await kernel.start(GOOD)
    expect(res.ok).toBe(true)
    expect(spawn).toHaveBeenCalledWith(
      GOOD.binaryPath,
      ['-d', GOOD.homeDir, '-f', GOOD.configPath],
      expect.objectContaining({ stdio: 'ignore' }),
    )
  })

  it('rejects a relative binaryPath (never spawns)', async () => {
    const spawn = vi.fn(() => fakeProc())
    const kernel = createPrivilegedKernel({
      spawn,
      statPath: okStat,
      platform: 'linux',
    })
    await expect(
      kernel.start({ ...GOOD, binaryPath: 'mihomo' }),
    ).rejects.toThrow('absolute path')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects a relative homeDir / configPath', async () => {
    const kernel = createPrivilegedKernel({
      statPath: okStat,
      platform: 'linux',
    })
    await expect(kernel.start({ ...GOOD, homeDir: '../etc' })).rejects.toThrow(
      'homeDir must be an absolute path',
    )
    await expect(
      kernel.start({ ...GOOD, configPath: 'config.yaml' }),
    ).rejects.toThrow('configPath must be an absolute path')
  })

  it('rejects a binaryPath that does not exist', async () => {
    const spawn = vi.fn(() => fakeProc())
    const kernel = createPrivilegedKernel({
      spawn,
      statPath: () => {
        throw new Error('ENOENT')
      },
      platform: 'linux',
    })
    await expect(kernel.start(GOOD)).rejects.toThrow('does not exist')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects a binaryPath that is not a regular file', async () => {
    const kernel = createPrivilegedKernel({
      statPath: () => ({ isFile: false, mode: 0o755 }),
      platform: 'linux',
    })
    await expect(kernel.start(GOOD)).rejects.toThrow('not a regular file')
  })

  it('rejects a group/world-writable binary on POSIX (anti-planting)', async () => {
    const spawn = vi.fn(() => fakeProc())
    const kernel = createPrivilegedKernel({
      spawn,
      statPath: () => ({ isFile: true, mode: 0o757 }),
      platform: 'linux',
    })
    await expect(kernel.start(GOOD)).rejects.toThrow('group/world-writable')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('skips the POSIX writable-bit check on win32 (synthetic mode bits)', async () => {
    const spawn = vi.fn(() => fakeProc())
    const kernel = createPrivilegedKernel({
      spawn,
      // 0o666 would trip the POSIX check, but Windows mode bits are synthetic.
      // (Paths stay POSIX-absolute so node:path.isAbsolute passes on the runner;
      // the `platform` flag is what gates the writable-bit check.)
      statPath: () => ({ isFile: true, mode: 0o666 }),
      platform: 'win32',
    })
    const res = await kernel.start(GOOD)
    expect(res.ok).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
  })
})

describe('createPrivilegedKernel — process lifecycle', () => {
  it('reports running only after the child emits spawn', async () => {
    const proc = new ChildProcess()
    const kernel = createPrivilegedKernel({
      spawn: () => proc,
      statPath: okStat,
    })
    const start = kernel.start(GOOD)
    expect(kernel.status().running).toBe(false)

    proc.emit('spawn')

    expect(await start).toEqual({ ok: true, running: true })
    proc.emit('exit', 0, null)
    expect(kernel.status().running).toBe(false)
  })

  it('rejects an actual asynchronous spawn error and clears the failed child', async () => {
    const logError = vi.fn()
    const kernel = createPrivilegedKernel({ statPath: okStat, logError })

    await expect(
      kernel.start({
        ...GOOD,
        binaryPath: '/nonexistent-metacubexd-test/mihomo',
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' })

    expect(logError).toHaveBeenCalledOnce()
    expect(kernel.status().running).toBe(false)
    await kernel.stop()
  })

  it('waits for exit after signaling, including concurrent stop requests', async () => {
    const proc = new ChildProcess()
    proc.kill = vi.fn(() => {
      Object.assign(proc, { killed: true })
      return true
    })
    const kernel = createPrivilegedKernel({
      spawn: () => proc,
      statPath: okStat,
    })
    const start = kernel.start(GOOD)
    proc.emit('spawn')
    await start
    let stopped = false
    const firstStop = kernel.stop().then(() => {
      stopped = true
    })
    const secondStop = kernel.stop()
    await Promise.resolve()

    expect(proc.killed).toBe(true)
    expect(stopped).toBe(false)
    expect(kernel.status().running).toBe(true)
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')

    Object.assign(proc, { signalCode: 'SIGTERM' })
    proc.emit('exit', null, 'SIGTERM')
    await Promise.all([firstStop, secondStop])
    expect(kernel.status().running).toBe(false)
  })

  it('escalates a stuck shutdown to SIGKILL and still waits for exit', async () => {
    vi.useFakeTimers()
    try {
      const proc = new ChildProcess()
      proc.kill = vi.fn(() => true)
      const kernel = createPrivilegedKernel({
        spawn: () => proc,
        statPath: okStat,
        stopTimeoutMs: 50,
        killTimeoutMs: 25,
      })
      const start = kernel.start(GOOD)
      proc.emit('spawn')
      await start
      let stopped = false
      const stop = kernel.stop().then(() => {
        stopped = true
      })

      await vi.advanceTimersByTimeAsync(50)

      expect(proc.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
      expect(stopped).toBe(false)
      Object.assign(proc, { signalCode: 'SIGKILL' })
      proc.emit('exit', null, 'SIGKILL')
      await stop
      expect(kernel.status().running).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails a shutdown that never exits instead of pretending its ports are free', async () => {
    vi.useFakeTimers()
    try {
      const proc = new ChildProcess()
      proc.kill = vi.fn(() => true)
      const kernel = createPrivilegedKernel({
        spawn: () => proc,
        statPath: okStat,
        stopTimeoutMs: 50,
        killTimeoutMs: 25,
      })
      const start = kernel.start(GOOD)
      proc.emit('spawn')
      await start
      const failure = kernel.stop().catch((error: unknown) => error)

      await vi.runAllTimersAsync()

      expect(await failure).toMatchObject({
        message: 'helper: kernel did not exit after SIGKILL',
      })
      expect(kernel.status().running).toBe(true)
      proc.emit('exit', null, 'SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases a real child listener before the sidecar reuses its port', async () => {
    let proc: ChildProcess | undefined
    const kernel = createPrivilegedKernel({
      statPath: okStat,
      spawn: () => {
        // An ordinary Node child, with a deliberately delayed graceful exit.
        proc = nodeSpawn(
          process.execPath,
          [
            '-e',
            `
          const server = require('node:net').createServer()
          server.listen(0, '127.0.0.1', () => process.send(server.address().port))
          process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50))
        `,
          ],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
        )
        return proc
      },
    })
    const replacement = createServer()
    try {
      const start = kernel.start(GOOD)
      const message = once(proc!, 'message')
      await start
      const [port] = await message

      await kernel.stop()

      expect(proc!.exitCode !== null || proc!.signalCode !== null).toBe(true)
      await new Promise<void>((resolve, reject) => {
        replacement.once('error', reject)
        replacement.listen(port as number, '127.0.0.1', resolve)
      })
    } finally {
      if (replacement.listening)
        await new Promise<void>((resolve) => replacement.close(() => resolve()))
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        const exited = once(proc, 'exit')
        proc.kill('SIGKILL')
        await exited
      }
    }
  })
})

describe('assertSafeKernelPaths', () => {
  it('passes for valid absolute paths + a normal file', () => {
    expect(() => assertSafeKernelPaths(GOOD, okStat, 'linux')).not.toThrow()
  })

  it('throws for an empty binaryPath', () => {
    expect(() =>
      assertSafeKernelPaths({ ...GOOD, binaryPath: '' }, okStat, 'linux'),
    ).toThrow('absolute path')
  })
})

describe('resolveHelperSecret', () => {
  const readOk = (p: string) => `secret-from:${p}`

  it('reads the secret from MCXD_HELPER_SECRET_FILE when set', () => {
    const env = { MCXD_HELPER_SECRET_FILE: '/etc/mcxd/helper.secret' }
    expect(resolveHelperSecret(env, readOk)).toBe(
      'secret-from:/etc/mcxd/helper.secret',
    )
  })

  it('prefers the file over the inline env var', () => {
    const env = {
      MCXD_HELPER_SECRET_FILE: '/etc/mcxd/helper.secret',
      MCXD_HELPER_SECRET: 'inline-old',
    }
    expect(resolveHelperSecret(env, () => 'from-file')).toBe('from-file')
  })

  it('falls back to MCXD_HELPER_SECRET when no file is configured (upgrade-skew)', () => {
    expect(resolveHelperSecret({ MCXD_HELPER_SECRET: 'inline' }, readOk)).toBe(
      'inline',
    )
  })

  it('throws when the secret file cannot be read', () => {
    const env = { MCXD_HELPER_SECRET_FILE: '/etc/mcxd/helper.secret' }
    expect(() =>
      resolveHelperSecret(env, () => {
        throw new Error('EACCES')
      }),
    ).toThrow('cannot read MCXD_HELPER_SECRET_FILE')
  })

  it('throws when the secret file is empty (no auth against a blank secret)', () => {
    const env = { MCXD_HELPER_SECRET_FILE: '/etc/mcxd/helper.secret' }
    expect(() => resolveHelperSecret(env, () => '')).toThrow('is empty')
  })

  it('throws when neither a file nor an inline secret is set', () => {
    expect(() => resolveHelperSecret({}, readOk)).toThrow('no shared secret')
  })
})
