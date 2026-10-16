import { Buffer } from 'node:buffer'
import { posix, win32 } from 'node:path'

/**
 * Per-OS privileged-helper install / uninstall — COMMAND GENERATION ONLY (spec
 * §12.4). This module composes the privileged service definition that runs the
 * bundled Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`) against the helper
 * entry, as root/admin, and the secret-file write + service registration —
 * then hands the whole thing to an INJECTED `elevate` (ONE elevation prompt per
 * install/uninstall). It NEVER installs a service, elevates, or spawns a
 * privileged process itself: every side effect goes through the injected
 * `exec` / `elevate`, so tests assert the generated commands + service-
 * definition contents without ever touching the real OS.
 *
 * Real service install / elevation / privileged run is verified ONLY on real
 * machines (B-3 + user smoke), NOT here.
 */

/**
 * Injected un-elevated command runner (mirrors `promisify(child_process.exec)`).
 * Used for the cheap `isInstalled()` probe, which never needs privilege.
 */
export type ExecFn = (
  cmd: string,
) => Promise<{ stdout: string; stderr: string }>

/**
 * Injected elevation runner: takes a single shell script and runs it with
 * administrator privileges (ONE prompt). Real impl: mac `osascript ... with
 * administrator privileges`, linux `pkexec`, win UAC `Start-Process -Verb
 * RunAs` (see `helper/elevate.ts`). Tests record the script and never prompt.
 * The script itself is NOT privileged — elevate must wrap it.
 */
export type ElevateFn = (
  script: string,
) => Promise<{ stdout: string; stderr: string }>

/** Injected helper version probe (e.g. the helper client's `getVersion`). */
export type GetVersionFn = () => Promise<string>

export interface HelperInstallerPaths {
  /** LaunchDaemon label / service identifier (darwin). */
  label: string
  /** systemd unit / Windows service name (linux/win32). */
  serviceName: string
  /**
   * Root-owned, ROOT-ONLY (0600 / SYSTEM-ACL'd) path the per-install shared
   * secret is written to during install. The privileged helper reads it as root;
   * no other local user can. The app uses its own user-owned copy under userData
   * (it does not read this file). (spec §12.3)
   */
  secretPath: string
}

export interface HelperInstallOptions {
  /** Absolute path to the bundled Electron binary (run as Node). */
  electronBin: string
  /** Absolute path to the bundled helper entry (`out/helper/index.js`). */
  helperEntry: string
  /** Local socket / named-pipe path the helper listens on. */
  socketPath: string
  /** Per-install shared secret stamped onto every IPC request. */
  secret: string
}

export interface CreateHelperInstallerOptions {
  /** Defaults to process.platform. */
  platform: NodeJS.Platform
  /** Injected un-elevated runner (isInstalled probe). */
  exec: ExecFn
  /** Injected elevation runner (the ONE privileged script). */
  elevate: ElevateFn
  /** Service identifiers + secret destination path. */
  paths: HelperInstallerPaths
  /** Optional version probe; without it `installedVersion()` returns undefined. */
  getVersion?: GetVersionFn
}

export interface HelperInstaller {
  /** Generate + run (via ONE elevate) the per-OS privileged install. */
  install: (opts: HelperInstallOptions) => Promise<void>
  /** Symmetric teardown (via ONE elevate). */
  uninstall: () => Promise<void>
  /** Cheap, un-elevated probe of whether the service is registered. */
  isInstalled: () => Promise<boolean>
  /** The installed helper's reported version (undefined if no probe injected). */
  installedVersion: () => Promise<string | undefined>
}

/** macOS: the canonical LaunchDaemons plist path for a label. */
function launchDaemonPlistPath(label: string): string {
  return `/Library/LaunchDaemons/${label}.plist`
}

/** linux: the canonical systemd unit path for a service name. */
function systemdUnitPath(serviceName: string): string {
  return `/etc/systemd/system/${serviceName}.service`
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * Compose the LaunchDaemon plist body: run the bundled Electron as Node against
 * the helper entry, with the env the helper reads (socket + secret), kept alive
 * as root.
 */
function buildLaunchDaemonPlist(
  label: string,
  opts: HelperInstallOptions,
  secretPath: string,
): string {
  // The env carries the PATH to the 0600 root-owned secret file, NOT the secret
  // value — the plist itself is root-owned but readable enough that embedding the
  // secret here would expose it to other local users (the cross-user privesc the
  // helper auth is meant to prevent). The helper reads the file as root.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(opts.electronBin)}</string>
    <string>${xml(opts.helperEntry)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
    <key>MCXD_HELPER_SOCKET</key>
    <string>${xml(opts.socketPath)}</string>
    <key>MCXD_HELPER_SECRET_FILE</key>
    <string>${xml(secretPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>`
}

/**
 * Compose the systemd unit body: run the bundled Electron as Node against the
 * helper entry as root, with the helper env, enabled at boot.
 */
function buildSystemdUnit(
  opts: HelperInstallOptions,
  secretPath: string,
): string {
  // Carry the PATH to the 0600 root-owned secret file, not the secret value —
  // /etc/systemd/system unit files are world-readable, so an inline secret would
  // leak to every local user. The helper reads the file as root.
  return `[Unit]
Description=metacubexd privileged TUN helper
After=network.target

[Service]
Type=exec
User=root
Environment=ELECTRON_RUN_AS_NODE=1
Environment=${systemdQuote(`MCXD_HELPER_SOCKET=${opts.socketPath}`)}
Environment=${systemdQuote(`MCXD_HELPER_SECRET_FILE=${secretPath}`)}
ExecStart=${systemdQuote(opts.electronBin)} ${systemdQuote(opts.helperEntry, true)}
Restart=on-failure

[Install]
WantedBy=multi-user.target`
}

/**
 * Single-quote a string for safe inclusion in a POSIX `sh -c` heredoc/command.
 * Wrap in single quotes and escape embedded single quotes the standard way.
 */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** systemd has its own quoting, specifier and (ExecStart only) env expansion. */
function systemdQuote(value: string, command = false): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('%', '%%')
  return `"${command ? escaped.replaceAll('$', () => '$$') : escaped}"`
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** A real SCM entry point: Electron/Node alone cannot be an sc.exe service. */
export function windowsServiceSource(
  serviceName: string,
  opts: HelperInstallOptions,
  secretPath: string,
): string {
  const literal = (value: string) => `@"${value.replaceAll('"', '""')}"`
  return `using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;

internal sealed class HelperService : ServiceBase
{
    private Process helper;
    private volatile bool stopping;

    private HelperService()
    {
        ServiceName = ${literal(serviceName)};
        CanStop = true;
        CanShutdown = true;
    }

    protected override void OnStart(string[] args)
    {
        stopping = false;
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = ${literal(opts.electronBin)};
        start.Arguments = "\\\"" + ${literal(opts.helperEntry)} + "\\\"";
        start.WorkingDirectory = Path.GetDirectoryName(start.FileName);
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        start.EnvironmentVariables["MCXD_HELPER_SOCKET"] = ${literal(opts.socketPath)};
        start.EnvironmentVariables["MCXD_HELPER_SECRET_FILE"] = ${literal(secretPath)};
        helper = new Process();
        helper.StartInfo = start;
        helper.EnableRaisingEvents = true;
        helper.Exited += delegate { if (!stopping) Environment.Exit(1); };
        helper.Start();
    }

    protected override void OnStop()
    {
        stopping = true;
        if (helper == null || helper.HasExited) return;
        // Terminate the whole helper/mihomo tree on SCM stop or OS shutdown.
        ProcessStartInfo stop = new ProcessStartInfo();
        stop.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe");
        stop.Arguments = "/PID " + helper.Id + " /T /F";
        stop.UseShellExecute = false;
        stop.CreateNoWindow = true;
        using (Process kill = Process.Start(stop))
        {
            if (!kill.WaitForExit(10000)) kill.Kill();
        }
        if (!helper.HasExited) helper.Kill();
        helper.WaitForExit(5000);
        helper.Dispose();
        helper = null;
    }

    protected override void OnShutdown() { OnStop(); }

    private static void Main() { ServiceBase.Run(new HelperService()); }
}`
}

/**
 * Build the per-OS privileged install/uninstall script + the un-elevated
 * isInstalled probe. Unknown platform throws (no dispatch path).
 */
export function createHelperInstaller(
  opts: CreateHelperInstallerOptions,
): HelperInstaller {
  const { platform, exec, elevate, paths, getVersion } = opts
  const { label, serviceName, secretPath } = paths

  function unsupported(): never {
    throw new Error(`unsupported platform for helper install: ${platform}`)
  }

  // ---- macOS (LaunchDaemon + launchctl) ----

  function darwinInstallScript(o: HelperInstallOptions): string {
    const plistPath = launchDaemonPlistPath(label)
    const plist = buildLaunchDaemonPlist(label, o, secretPath)
    // ONE elevated script: write the secret root-owned + 0600 (root-only — the
    // helper reads it as root; no other local user may read it), write the
    // plist, then bootstrap the daemon into the system domain.
    return [
      'set -eu',
      `mkdir -p -- ${shQuote(posix.dirname(secretPath))}`,
      // Create the secret already-restricted: under `umask 077` the redirection
      // makes the file 0600 from the first byte, so the secret is NEVER briefly
      // world-readable between the write and the chmod (the chmod below stays as
      // an explicit belt-and-braces guarantee).
      `(umask 077; printf '%s' ${shQuote(o.secret)} > ${shQuote(secretPath)})`,
      `chown root: ${shQuote(secretPath)}`,
      `chmod 0600 ${shQuote(secretPath)}`,
      `cat > ${shQuote(plistPath)} <<'MCXD_PLIST_EOF'\n${plist}\nMCXD_PLIST_EOF`,
      `chown root:wheel ${shQuote(plistPath)}`,
      `chmod 0644 ${shQuote(plistPath)}`,
      `launchctl bootout system/${label} 2>/dev/null || true`,
      `launchctl bootstrap system ${shQuote(plistPath)}`,
    ].join('\n')
  }

  function darwinUninstallScript(): string {
    const plistPath = launchDaemonPlistPath(label)
    return [
      'set -eu',
      `launchctl bootout system ${shQuote(plistPath)} || true`,
      `rm -f -- ${shQuote(plistPath)}`,
      `rm -f -- ${shQuote(secretPath)}`,
    ].join('\n')
  }

  async function darwinIsInstalled(): Promise<boolean> {
    try {
      const { stdout } = await exec(`launchctl print system/${label}`)
      return stdout.includes(label)
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        err.code === 113 // service not found in the requested domain
      ) {
        return false
      }
      throw err
    }
  }

  // ---- Linux (systemd + pkexec) ----

  function linuxInstallScript(o: HelperInstallOptions): string {
    const unitPath = systemdUnitPath(serviceName)
    const unit = buildSystemdUnit(o, secretPath)
    return [
      'set -eu',
      `mkdir -p -- ${shQuote(posix.dirname(secretPath))}`,
      // umask 077 -> the file is 0600 from the first byte, so the secret is never
      // briefly world-readable between write and chmod (chmod stays explicit).
      `(umask 077; printf '%s' ${shQuote(o.secret)} > ${shQuote(secretPath)})`,
      `chown root: ${shQuote(secretPath)}`,
      // 0600: root-only. The helper reads it as root; the world-readable unit
      // file carries only the PATH, never the secret value.
      `chmod 0600 ${shQuote(secretPath)}`,
      `cat > ${shQuote(unitPath)} <<'MCXD_UNIT_EOF'\n${unit}\nMCXD_UNIT_EOF`,
      `chmod 0644 ${shQuote(unitPath)}`,
      `systemctl daemon-reload`,
      `systemctl enable ${shQuote(serviceName)}`,
      // An installed helper can be stale or dead; --now does not restart an
      // already running service after replacing its secret or command.
      `systemctl restart ${shQuote(serviceName)}`,
    ].join('\n')
  }

  function linuxUninstallScript(): string {
    const unitPath = systemdUnitPath(serviceName)
    return [
      'set -eu',
      `systemctl disable --now ${shQuote(serviceName)} || true`,
      `rm -f -- ${shQuote(unitPath)}`,
      `systemctl daemon-reload`,
      `rm -f -- ${shQuote(secretPath)}`,
    ].join('\n')
  }

  async function linuxIsInstalled(): Promise<boolean> {
    try {
      const { stdout } = await exec(
        `systemctl is-enabled ${shQuote(serviceName)}`,
      )
      return stdout
        .split('\n')
        .some((line) => line.trim().toLowerCase() === 'enabled')
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err.code === 1 || err.code === 4) // disabled/failed or not-found
      ) {
        return false
      }
      throw err
    }
  }

  // ---- Windows (ServiceBase host + UAC runas) ----
  // The helper's pipe accepts local app connections; its per-install secret
  // authenticates requests. The host and its secret live in a dedicated
  // ProgramData directory restricted to SYSTEM and administrators.

  function winInstallScript(o: HelperInstallOptions): string {
    const serviceDir = win32.dirname(secretPath)
    const serviceExe = win32.join(serviceDir, 'helper-service.exe')
    const sourceFile = win32.join(serviceDir, 'helper-service.cs')
    const source = Buffer.from(
      windowsServiceSource(serviceName, o, secretPath),
      'utf8',
    ).toString('base64')
    return [
      "$ErrorActionPreference = 'Stop'",
      `$serviceName = ${psQuote(serviceName)}`,
      `$serviceDir = ${psQuote(serviceDir)}`,
      `$serviceExe = ${psQuote(serviceExe)}`,
      `$sourceFile = ${psQuote(sourceFile)}`,
      // Create the directory with restricted ACLs BEFORE writing source/secret.
      'New-Item -ItemType Directory -Path $serviceDir -Force | Out-Null',
      '$acl = New-Object System.Security.AccessControl.DirectorySecurity',
      '$acl.SetAccessRuleProtection($true, $false)',
      "foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {",
      '  $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)',
      "  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
      '  $acl.AddAccessRule($rule)',
      '}',
      'Set-Acl -LiteralPath $serviceDir -AclObject $acl',
      '$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue',
      'if ($existing) {',
      "  if ($existing.Status -ne 'Stopped') {",
      '    Stop-Service -InputObject $existing -Force',
      "    $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))",
      '  }',
      '  $existing.Dispose()',
      '}',
      `[IO.File]::WriteAllText(${psQuote(secretPath)}, ${psQuote(o.secret)}, (New-Object Text.UTF8Encoding($false)))`,
      `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(source)}))`,
      '[IO.File]::WriteAllText($sourceFile, $source, [Text.Encoding]::UTF8)',
      // Windows ships the .NET Framework compiler; no downloads or npm/native
      // dependencies are needed. Prefer the native compiler, then x86 fallback.
      "$compiler = @('Framework64', 'Framework') | ForEach-Object { Join-Path $env:SystemRoot ('Microsoft.NET\\' + $_ + '\\v4.0.30319\\csc.exe') } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1",
      "if (!$compiler) { throw 'The .NET Framework v4 compiler required by the TUN helper was not found.' }",
      '$assembly = Join-Path (Split-Path -Parent $compiler) System.ServiceProcess.dll',
      '& $compiler /nologo /target:winexe ("/reference:$assembly") ("/out:$serviceExe") $sourceFile',
      "if ($LASTEXITCODE -ne 0) { throw 'Failed to compile the Windows TUN service host.' }",
      `$binaryPath = '"' + $serviceExe + '"'`,
      'if ($existing) {',
      `  $service = Get-CimInstance -ClassName Win32_Service -Filter ${psQuote(`Name='${serviceName}'`)}`,
      "  $result = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{ PathName = $binaryPath; StartMode = 'Automatic'; StartName = 'LocalSystem' }",
      "  if ($result.ReturnValue -ne 0) { throw ('Failed to update TUN service: ' + $result.ReturnValue) }",
      '} else {',
      '  New-Service -Name $serviceName -BinaryPathName $binaryPath -StartupType Automatic | Out-Null',
      '}',
      // Earlier releases registered Electron directly and injected an env block
      // through SCM. The service host now supplies its child's environment.
      `Remove-ItemProperty -LiteralPath ${psQuote(`HKLM:\\SYSTEM\\CurrentControlSet\\Services\\${serviceName}`)} -Name Environment -ErrorAction SilentlyContinue`,
      'Start-Service -Name $serviceName',
      '$started = Get-Service -Name $serviceName',
      "$started.WaitForStatus('Running', [TimeSpan]::FromSeconds(20))",
      '$started.Dispose()',
    ].join('\r\n')
  }

  function winUninstallScript(): string {
    return [
      "$ErrorActionPreference = 'Stop'",
      `$serviceName = ${psQuote(serviceName)}`,
      '$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue',
      'if ($service) {',
      "  if ($service.Status -ne 'Stopped') {",
      '    Stop-Service -InputObject $service -Force',
      "    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))",
      '  }',
      '  $service.Dispose()',
      "  & (Join-Path $env:SystemRoot 'System32\\sc.exe') delete $serviceName",
      "  if ($LASTEXITCODE -ne 0) { throw 'Failed to remove the TUN service.' }",
      '}',
      ...[
        secretPath,
        win32.join(win32.dirname(secretPath), 'helper-service.exe'),
        win32.join(win32.dirname(secretPath), 'helper-service.cs'),
      ].map(
        (path) =>
          `if (Test-Path -LiteralPath ${psQuote(path)}) { Remove-Item -LiteralPath ${psQuote(path)} -Force }`,
      ),
    ].join('\r\n')
  }

  async function winIsInstalled(): Promise<boolean> {
    try {
      const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
      const { stdout } = await exec(
        `"${root}\\System32\\sc.exe" query ${serviceName}`,
      )
      return stdout.includes(serviceName) && !stdout.includes('1060')
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        err.code === 1060 // ERROR_SERVICE_DOES_NOT_EXIST
      ) {
        return false
      }
      throw err
    }
  }

  return {
    async install(installOpts: HelperInstallOptions) {
      switch (platform) {
        case 'darwin':
          await elevate(darwinInstallScript(installOpts))
          return
        case 'linux':
          await elevate(linuxInstallScript(installOpts))
          return
        case 'win32':
          await elevate(winInstallScript(installOpts))
          return
        default:
          return unsupported()
      }
    },
    async uninstall() {
      switch (platform) {
        case 'darwin':
          await elevate(darwinUninstallScript())
          return
        case 'linux':
          await elevate(linuxUninstallScript())
          return
        case 'win32':
          await elevate(winUninstallScript())
          return
        default:
          return unsupported()
      }
    },
    async isInstalled() {
      switch (platform) {
        case 'darwin':
          return darwinIsInstalled()
        case 'linux':
          return linuxIsInstalled()
        case 'win32':
          return winIsInstalled()
        default:
          return unsupported()
      }
    },
    async installedVersion() {
      if (!getVersion) return undefined
      return getVersion()
    },
  }
}
