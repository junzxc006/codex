import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createHelperInstaller,
  windowsServiceSource,
} from '../helper/installer'

const PATHS = {
  label: 'io.github.metacubexd.helper',
  serviceName: 'metacubexd-helper',
  secretPath: '/etc/metacubexd/helper.secret',
}
const INSTALL = {
  electronBin: '/opt/Meta CubeXD/metacubexd',
  helperEntry:
    '/opt/Meta CubeXD/resources/app.asar.unpacked/out/helper/index.js',
  socketPath: '/run/metacubexd-helper.sock',
  secret: 'shared-install-secret',
}
const WINDOWS_PATHS = {
  ...PATHS,
  secretPath: 'C:\\ProgramData\\metacubexd-helper\\helper.secret',
}
const WINDOWS_INSTALL = {
  ...INSTALL,
  electronBin: "C:\\Users\\O'Brien 中文\\Meta CubeXD\\metacubexd.exe",
  helperEntry:
    "C:\\Users\\O'Brien 中文\\Meta CubeXD\\resources\\out\\helper\\index.js",
  socketPath: '\\\\.\\pipe\\metacubexd-helper',
}

function setup(platform: NodeJS.Platform, response: string | Error = '') {
  const exec = vi.fn(async () => {
    if (response instanceof Error) throw response
    return { stdout: response, stderr: '' }
  })
  const elevate = vi.fn(async (_script: string) => ({ stdout: '', stderr: '' }))
  const installer = createHelperInstaller({
    platform,
    exec,
    elevate,
    paths: platform === 'win32' ? WINDOWS_PATHS : PATHS,
  })
  return { exec, elevate, installer }
}

function commandError(code: number): Error {
  return Object.assign(new Error(`command exited ${code}`), { code })
}

function scriptFrom(elevate: ReturnType<typeof setup>['elevate']): string {
  return elevate.mock.calls[0]?.[0] ?? ''
}

describe('helper installer', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'installs %s through one elevation and no unprivileged command',
    async (platform) => {
      const { installer, exec, elevate } = setup(platform)
      await installer.install(platform === 'win32' ? WINDOWS_INSTALL : INSTALL)
      expect(elevate).toHaveBeenCalledTimes(1)
      expect(exec).not.toHaveBeenCalled()
    },
  )

  it('quotes Linux service arguments, escapes systemd expansion, and restarts existing services', async () => {
    const { installer, elevate } = setup('linux')
    await installer.install({
      ...INSTALL,
      electronBin: '/opt/100% $HOME/Meta CubeXD',
    })
    const script = scriptFrom(elevate)
    expect(script.startsWith('set -eu\n')).toBe(true)
    expect(script).toContain(
      `ExecStart="/opt/100%% $HOME/Meta CubeXD" "${INSTALL.helperEntry}"`,
    )
    expect(script).toContain(
      'Environment="MCXD_HELPER_SOCKET=/run/metacubexd-helper.sock"',
    )
    expect(script).toContain(
      'Environment="MCXD_HELPER_SECRET_FILE=/etc/metacubexd/helper.secret"',
    )
    expect(script).not.toContain('Environment=MCXD_HELPER_SECRET=')
    expect(script).toContain(
      "(umask 077; printf '%s' 'shared-install-secret' > '/etc/metacubexd/helper.secret')",
    )
    expect(script).toContain("chmod 0600 '/etc/metacubexd/helper.secret'")
    expect(script).toContain(
      "systemctl enable 'metacubexd-helper'\nsystemctl restart 'metacubexd-helper'",
    )
    if (process.platform !== 'win32')
      execFileSync('/bin/sh', ['-n'], { input: script })
  })

  it('quotes the macOS secret directory and reloads the daemon during repair', async () => {
    const { exec, elevate } = setup('darwin')
    const secretPath = '/Library/Application Support/metacubexd/helper.secret'
    await createHelperInstaller({
      platform: 'darwin',
      exec,
      elevate,
      paths: { ...PATHS, secretPath },
    }).install({
      ...INSTALL,
      electronBin: '/Applications/A & B.app/Contents/MacOS/metacubexd',
    })
    const script = scriptFrom(elevate)
    expect(script).toContain(
      "mkdir -p -- '/Library/Application Support/metacubexd'",
    )
    expect(script).toContain(`> '${secretPath}')`)
    expect(script).toContain(
      '/Applications/A &amp; B.app/Contents/MacOS/metacubexd',
    )
    expect(script).toContain(
      'launchctl bootout system/io.github.metacubexd.helper',
    )
    expect(script).toContain(
      "launchctl bootstrap system '/Library/LaunchDaemons/io.github.metacubexd.helper.plist'",
    )
    expect(script).not.toContain('<key>MCXD_HELPER_SECRET</key>')
    if (process.platform !== 'win32')
      execFileSync('/bin/sh', ['-n'], { input: script })
  })

  it('builds a real Windows SCM host, keeps secrets out of it, and repairs the old service', async () => {
    const { installer, elevate } = setup('win32')
    await installer.install(WINDOWS_INSTALL)
    const script = scriptFrom(elevate)
    const source = windowsServiceSource(
      PATHS.serviceName,
      WINDOWS_INSTALL,
      WINDOWS_PATHS.secretPath,
    )
    expect(source).toContain('ServiceBase.Run(new HelperService())')
    expect(source).toContain('protected override void OnStart')
    expect(source).toContain('protected override void OnStop')
    expect(source).toContain(
      `start.Arguments = "\\\"" + @"${WINDOWS_INSTALL.helperEntry}" + "\\\"";`,
    )
    expect(source).toContain(
      'start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1"',
    )
    expect(source).toContain(WINDOWS_PATHS.secretPath)
    expect(source).not.toContain(WINDOWS_INSTALL.secret)
    expect(script).toContain("$ErrorActionPreference = 'Stop'")
    expect(script).toContain('Set-Acl -LiteralPath $serviceDir -AclObject $acl')
    expect(script.indexOf('Set-Acl')).toBeLessThan(
      script.indexOf('[IO.File]::WriteAllText'),
    )
    expect(script).toContain("@('S-1-5-18', 'S-1-5-32-544')")
    expect(script).toContain('csc.exe')
    expect(script).toContain('if ($LASTEXITCODE -ne 0)')
    expect(script).toContain('Stop-Service -InputObject $existing -Force')
    expect(script).toContain("$existing.WaitForStatus('Stopped'")
    expect(script).toContain(
      'Invoke-CimMethod -InputObject $service -MethodName Change',
    )
    expect(script).toContain(
      'New-Service -Name $serviceName -BinaryPathName $binaryPath',
    )
    expect(script).toContain("$binaryPath = '\"' + $serviceExe + '\"'")
    expect(script).toContain('Start-Service -Name $serviceName')
    expect(script).not.toContain('sc create')
  })

  it.each(['darwin', 'linux', 'win32'] as const)(
    'uninstalls %s in one elevation',
    async (platform) => {
      const { installer, elevate } = setup(platform)
      await installer.uninstall()
      expect(elevate).toHaveBeenCalledTimes(1)
      const script = scriptFrom(elevate)
      expect(script).toContain('helper.secret')
      if (platform === 'win32') {
        expect(script).toContain('Stop-Service')
        expect(script).toContain('delete $serviceName')
        expect(script).toContain('helper-service.exe')
      } else if (process.platform !== 'win32') {
        execFileSync('/bin/sh', ['-n'], { input: script })
      }
    },
  )

  it.each([
    ['darwin', 113],
    ['linux', 1],
    ['linux', 4],
    ['win32', 1060],
  ] as const)(
    'treats expected missing/disabled %s exit %d as not installed',
    async (platform, code) => {
      expect(
        await setup(platform, commandError(code)).installer.isInstalled(),
      ).toBe(false)
    },
  )

  it.each([
    ['darwin', 'io.github.metacubexd.helper => ...'],
    ['linux', 'enabled\n'],
    ['win32', 'SERVICE_NAME: metacubexd-helper'],
  ] as const)('probes %s without elevation', async (platform, stdout) => {
    const { installer, elevate } = setup(platform, stdout)
    expect(await installer.isInstalled()).toBe(true)
    expect(elevate).not.toHaveBeenCalled()
  })

  it('does not hide unexpected installer errors', async () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const error = commandError(5)
      await expect(setup(platform, error).installer.isInstalled()).rejects.toBe(
        error,
      )
      const { installer, elevate } = setup(platform)
      elevate.mockRejectedValueOnce(error)
      await expect(installer.install(INSTALL)).rejects.toBe(error)
    }
  })

  it('rejects unsupported platforms and supports the optional version probe', async () => {
    const { installer, exec, elevate } = setup('aix')
    await expect(installer.install(INSTALL)).rejects.toThrow(
      'unsupported platform',
    )
    await expect(installer.uninstall()).rejects.toThrow('unsupported platform')
    await expect(installer.isInstalled()).rejects.toThrow(
      'unsupported platform',
    )
    expect(await installer.installedVersion()).toBeUndefined()
    const getVersion = vi.fn(async () => '1')
    expect(
      await createHelperInstaller({
        platform: 'linux',
        exec,
        elevate,
        paths: PATHS,
        getVersion,
      }).installedVersion(),
    ).toBe('1')
  })

  // Real Windows compiler + PowerShell parser, without elevation, SCM writes,
  // or helper execution. Other platforms explicitly skip this platform check.
  it.skipIf(process.platform !== 'win32')(
    'compiles the service host and parses both generated PowerShell scripts on Windows',
    async () => {
      const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
      const compiler = ['Framework64', 'Framework']
        .map((framework) =>
          join(root, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'),
        )
        .find((path) => existsSync(path))
      expect(compiler, '.NET Framework compiler').toBeDefined()
      const temp = mkdtempSync(join(tmpdir(), "mcxd O'Brien 中文 "))
      try {
        const source = join(temp, 'helper.cs')
        const binary = join(temp, 'helper.exe')
        writeFileSync(
          source,
          `\uFEFF${windowsServiceSource(
            PATHS.serviceName,
            WINDOWS_INSTALL,
            WINDOWS_PATHS.secretPath,
          )}`,
        )
        execFileSync(compiler!, [
          '/nologo',
          '/target:winexe',
          `/reference:${join(dirname(compiler!), 'System.ServiceProcess.dll')}`,
          `/out:${binary}`,
          source,
        ])
        expect(readFileSync(binary).subarray(0, 2).toString()).toBe('MZ')
        const { installer, elevate } = setup('win32')
        await installer.install(WINDOWS_INSTALL)
        await installer.uninstall()
        for (const [index, [script]] of elevate.mock.calls.entries()) {
          const file = join(temp, `script-${index}.ps1`)
          writeFileSync(file, `\uFEFF${script}`)
          const parse = `$errors = $null; $tokens = $null; [void][Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors); if ($errors.Count) { throw ($errors | Out-String) }`
          execFileSync(
            join(
              root,
              'System32',
              'WindowsPowerShell',
              'v1.0',
              'powershell.exe',
            ),
            ['-NoProfile', '-NonInteractive', '-Command', parse],
          )
        }
      } finally {
        rmSync(temp, { recursive: true, force: true })
      }
    },
    30000,
  )
})
