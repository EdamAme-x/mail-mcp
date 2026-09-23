import { okAsync } from 'neverthrow'
import { type CredentialStore } from './store.js'
import { attempt, guard, type AsyncResult } from './result.js'

type Tokens = { accessToken: string; expiresAt: number }

/** One refresh per account; late 401s reuse the token already persisted by another request. */
export class TokenSession<C extends Tokens> {
  private refreshing?: AsyncResult<C>
  private unsaved?: C
  constructor(private store: CredentialStore<C>, private renew: (current: C) => AsyncResult<C>) {}

  read(): AsyncResult<C> {
    if (this.unsaved) return this.refresh()
    return attempt(() => this.store.read(), 'STORAGE').andThen(credentials => credentials.expiresAt <= Date.now() + 60_000 ? this.refresh() : okAsync(credentials))
  }

  refresh(rejectedAccessToken?: string): AsyncResult<C> {
    if (this.refreshing) return this.refreshing
    const work = guard(() => {
      // A rotated refresh token is retained in memory if its disk write failed.
      if (this.unsaved) return this.persist(this.unsaved)
      return attempt(() => this.store.read(), 'STORAGE').andThen(current => {
        const fresh = current.expiresAt > Date.now() + 60_000
        if (fresh && (rejectedAccessToken === undefined || current.accessToken !== rejectedAccessToken)) return okAsync(current)
        return this.renew(current).andThen(updated => {
          this.unsaved = updated
          return this.persist(updated)
        })
      })
    })
    const pending = guard(() => Promise.resolve(work).finally(() => {
      if (this.refreshing === pending) this.refreshing = undefined
    }))
    this.refreshing = pending
    return pending
  }

  private persist(credentials: C): AsyncResult<C> {
    return attempt(() => this.store.save(credentials), 'STORAGE').map(() => {
      this.unsaved = undefined
      return credentials
    })
  }
}
