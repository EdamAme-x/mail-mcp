import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { failure, MailFault, validate } from './result.js'

export const credentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
})
export type Credentials = z.infer<typeof credentialsSchema>
export type CredentialStore<T> = { read(): Promise<T>; save(credentials: T): Promise<void>; directory: string }

export async function readStored<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let text: string
  try { text = await readFile(path, 'utf8') }
  catch (error) { throw new MailFault(failure((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ACCOUNT_NOT_FOUND' : 'STORAGE')) }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new MailFault(failure('CREDENTIALS_INVALID')) }
  const result = validate(schema, value, 'CREDENTIALS_INVALID')
  if (result.isErr()) throw new MailFault(result.error)
  return result.value
}

export async function writePrivateJson(directory: string, filename: string, data: unknown) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporary = join(directory, `.write-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(directory, filename))
  } finally {
    await rm(temporary, { force: true })
  }
}

export class TokenStore {
  constructor(readonly directory = join(homedir(), '.mail-mcp')) {}

  async read(): Promise<Credentials> {
    return readStored(join(this.directory, 'tokens.json'), credentialsSchema)
  }

  async save(credentials: Credentials): Promise<void> {
    const data = credentialsSchema.parse(credentials)
    await writePrivateJson(this.directory, 'tokens.json', data)
  }

  async clear(): Promise<void> {
    await rm(join(this.directory, 'tokens.json'), { force: true })
  }
}
