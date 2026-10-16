import type { ProfileStore } from '@metacubexd/agent/types'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildTunConfig,
  createProfileStore,
  TunPreconditionError,
} from '@metacubexd/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import { createTunConfigWriter } from '../tun-config'
import { createTunController } from '../tun-controller'

describe('tun config handoff', () => {
  let dir: string
  let activeConfigPath: string
  let profiles: ProfileStore
  let activeId: string
  let runtimeConfig: Record<string, unknown>
  let setSection: ReturnType<typeof createTunConfigWriter>

  const readRuntime = async () =>
    parse(await readFile(activeConfigPath, 'utf8')) as Record<string, unknown>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcxd-tun-config-'))
    activeConfigPath = join(dir, 'config.yaml')
    profiles = createProfileStore({
      dir: join(dir, 'profiles'),
      activeConfigPath,
    })
    const profile = await profiles.create({
      name: 'subscription',
      content: stringify({
        'external-controller': '0.0.0.0:9090',
        secret: 'subscription-secret',
        'mixed-port': 7890,
        'socks-port': 7890,
        mode: 'rule',
        proxies: [
          { name: 'proxy', type: 'http', server: 'localhost', port: 80 },
        ],
      }),
    })
    activeId = profile.id
    await profiles.create({
      name: 'merge',
      type: 'merge',
      content: stringify({
        rules: ['MATCH,DIRECT'],
        tun: { enable: false, stack: 'system' },
      }),
    })
    await profiles.setActive(activeId)
    // The normal supervisor adds these managed values before starting the
    // sidecar. The helper must keep them when it takes over the same file.
    runtimeConfig = {
      ...(await readRuntime()),
      'external-controller': '127.0.0.1:49090',
      secret: 'desktop-managed-secret',
      'mixed-port': 47890,
    }
    delete runtimeConfig['socks-port']
    await writeFile(
      activeConfigPath,
      `# running desktop config\n${stringify(runtimeConfig)}`,
    )
    setSection = createTunConfigWriter({ profiles, activeConfigPath })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes TUN to the helper config while preserving managed and composed settings', async () => {
    const tun = buildTunConfig({ stack: 'gvisor' })

    await setSection('tun', tun)

    expect(await profiles.getSection(activeId, 'tun')).toEqual(tun)
    expect(await readRuntime()).toEqual({ ...runtimeConfig, tun })
    expect(await readFile(activeConfigPath, 'utf8')).toContain(
      '# running desktop config',
    )
    // Managed runtime values never leak back into the subscription source.
    expect(await profiles.getSection(activeId, 'secret')).toBe(
      'subscription-secret',
    )
  })

  it('removes TUN from both files without reapplying a merge layer or source ports', async () => {
    await setSection('tun', buildTunConfig({ stack: 'system' }))

    await setSection('tun', null)

    const expected = { ...runtimeConfig }
    delete expected.tun
    expect(await readRuntime()).toEqual(expected)
    expect(await profiles.getSection(activeId, 'tun')).toBeNull()
  })

  it('restores a TUN-free sidecar config when privileged startup fails', async () => {
    const failure = new Error('helper startup failed')
    const startSidecar = vi.fn(async () => {
      expect(await readRuntime()).not.toHaveProperty('tun')
    })
    const controller = createTunController({
      injectTun: (tun) => setSection('tun', tun),
      removeTun: () => setSection('tun', null),
      stopKernel: async () => {},
      startPrivileged: async () => {
        expect((await readRuntime()).tun).toEqual(
          buildTunConfig({ stack: 'gvisor' }),
        )
        throw failure
      },
      startSidecar,
    })

    await expect(controller.enable({ stack: 'gvisor' })).rejects.toBe(failure)

    expect(startSidecar).toHaveBeenCalledOnce()
    expect(await profiles.getSection(activeId, 'tun')).toBeNull()
    expect(await readRuntime()).toMatchObject({
      'external-controller': '127.0.0.1:49090',
      secret: 'desktop-managed-secret',
      'mixed-port': 47890,
    })
  })

  it('rejects an absent active profile without editing the config', async () => {
    await profiles.resetActive()
    const before = await readFile(activeConfigPath, 'utf8')

    await expect(
      setSection('tun', buildTunConfig({ stack: 'system' })),
    ).rejects.toBeInstanceOf(TunPreconditionError)

    expect(await readFile(activeConfigPath, 'utf8')).toBe(before)
    expect(await profiles.getSection(activeId, 'tun')).toBeNull()
  })

  it.each(['tun: [invalid', '- not-a-mapping\n'])(
    'does not overwrite an invalid runtime document: %s',
    async (invalid) => {
      await writeFile(activeConfigPath, invalid)

      await expect(
        setSection('tun', buildTunConfig({ stack: 'system' })),
      ).rejects.toThrow()

      expect(await readFile(activeConfigPath, 'utf8')).toBe(invalid)
      expect(await profiles.getSection(activeId, 'tun')).toBeNull()
    },
  )
})
