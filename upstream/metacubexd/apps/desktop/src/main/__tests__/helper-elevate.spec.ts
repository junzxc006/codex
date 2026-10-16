import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { createHelperElevate } from '../helper/elevate'

function setup(platform: NodeJS.Platform) {
  const exec = vi.fn(async (_cmd: string) => ({ stdout: '', stderr: '' }))
  const fs = {
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    tmpdir: () => "C:\\Users\\O'Brien 中文\\AppData\\Local\\Temp",
    join: (...parts: string[]) => parts.join('\\'),
  }
  const elevate = createHelperElevate({
    platform,
    exec,
    fs,
    tempName: () => 'mcxd-elevate-test.ps1',
  })
  return { exec, fs, elevate }
}

function decodedCommand(command: string): string {
  return Buffer.from(command.split('-EncodedCommand ')[1]!, 'base64').toString(
    'utf16le',
  )
}

describe('helper elevation', () => {
  it('keeps the complete macOS script as one AppleScript argument including single quotes', async () => {
    const { exec, elevate } = setup('darwin')
    const script =
      "printf '%s' 'secret' > '/Library/Application Support/helper.secret'"
    await elevate(script)
    const command = exec.mock.calls[0]![0]
    expect(command).toContain('osascript -e')
    expect(command).toContain('with administrator privileges')
    if (process.platform !== 'win32') {
      // Replace osascript with printf to inspect shell argument boundaries only.
      const args = execFileSync(
        '/bin/sh',
        ['-c', command.replace('osascript', "printf '%s\\n'")],
        { encoding: 'utf8' },
      )
      expect(args).toBe(
        `-e\ndo shell script "${script}" with administrator privileges\n`,
      )
    }
  })

  it('runs the complete Linux script through one pkexec invocation', async () => {
    const { exec, elevate } = setup('linux')
    await elevate("systemctl restart 'metacubexd-helper'")
    expect(exec).toHaveBeenCalledTimes(1)
    const command = exec.mock.calls[0]![0]
    expect(command).toMatch(/^pkexec \/bin\/bash -c /)
    if (process.platform !== 'win32')
      execFileSync('/bin/sh', ['-n'], { input: command })
  })

  it('uses a Unicode PowerShell script, quotes its path, and propagates the elevated exit code', async () => {
    const { exec, fs, elevate } = setup('win32')
    const script = "$ErrorActionPreference = 'Stop'\r\nthrow 'installer failed'"
    await elevate(script)
    const path =
      "C:\\Users\\O'Brien 中文\\AppData\\Local\\Temp\\mcxd-elevate-test.ps1"
    expect(fs.writeFileSync).toHaveBeenCalledWith(path, `\uFEFF${script}`)
    expect(exec).toHaveBeenCalledTimes(1)
    const command = exec.mock.calls[0]![0]
    expect(command).toMatch(
      /^"[^"]+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"/,
    )
    const outer = decodedCommand(command)
    expect(outer).toContain("$ErrorActionPreference = 'Stop'")
    expect(outer).toContain('-Verb RunAs -Wait -PassThru')
    expect(outer).toContain('exit $process.ExitCode')
    expect(outer).toContain(`-File "${path.replaceAll("'", "''")}"`)
    expect(command).not.toContain('installer failed')
    expect(fs.unlinkSync).toHaveBeenCalledWith(path)
  })

  it.each([
    'The operation was canceled by the user.',
    'Command exited with code 1',
  ])('propagates %s and removes the temporary script', async (message) => {
    const { exec, fs, elevate } = setup('win32')
    const error = new Error(message)
    exec.mockRejectedValueOnce(error)
    await expect(elevate('throw "error"')).rejects.toBe(error)
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1)
  })

  it('reports unsupported platforms', async () => {
    await expect(setup('freebsd').elevate('echo hi')).rejects.toThrow(
      'unsupported platform',
    )
  })
})
