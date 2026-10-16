import type { ProfileStore } from '@metacubexd/agent/types'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { TunPreconditionError } from '@metacubexd/agent'
import { isMap, parseDocument } from 'yaml'

/**
 * Persist TUN edits in both the profile and the file the helper starts with.
 * Re-activating the profile here would discard the supervisor's managed API
 * address, secret and ports. Edit the already-composed runtime document so
 * those values, along with merge/script results, survive the handoff.
 */
export function createTunConfigWriter(opts: {
  profiles: Pick<ProfileStore, 'getActiveId' | 'setSection'>
  activeConfigPath: string
}): (key: string, value: unknown) => Promise<void> {
  return async (key, value) => {
    const activeId = await opts.profiles.getActiveId()
    if (!activeId)
      throw new TunPreconditionError('tun: no active profile to edit')

    const doc = parseDocument(await readFile(opts.activeConfigPath, 'utf8'))
    if (doc.errors.length) throw doc.errors[0]
    if (!isMap(doc.contents))
      throw new Error('tun: active config must be a YAML mapping')
    if (value == null) doc.delete(key)
    else doc.set(key, value)

    await opts.profiles.setSection(activeId, key, value)
    const temporary = `${opts.activeConfigPath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, doc.toString())
      await rename(temporary, opts.activeConfigPath)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
