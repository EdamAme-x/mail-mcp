import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export const credentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
})
export type Credentials = z.infer<typeof credentialsSchema>

export class TokenStore {
  constructor(readonly directory = join(homedir(), '.mail-mcp')) {}

  async read(): Promise<Credentials> {
    try {
      return credentialsSchema.parse(JSON.parse(await readFile(join(this.directory, 'tokens.json'), 'utf8')))
    } catch {
      throw new Error('No valid credentials found. Run mail-mcp login --credentials <client.json>.')
    }
  }

  async save(credentials: Credentials): Promise<void> {
    const data = credentialsSchema.parse(credentials)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    const temporary = join(this.directory, `.tokens-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(temporary, join(this.directory, 'tokens.json'))
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async clear(): Promise<void> {
    await rm(join(this.directory, 'tokens.json'), { force: true })
  }
}
