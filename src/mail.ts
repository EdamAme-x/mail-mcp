export type Search = { text?: string; query?: string; limit?: number; pageToken?: string }
export type Summary = { id: string; threadId?: string; subject?: string; from?: string; date?: string; snippet?: string; unread?: boolean }
export type Page = { messages: Summary[]; nextPageToken?: string }
export type MailProvider = { list(input: Search): Promise<Page>; get(id: string): Promise<unknown> }

export async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++
      results[i] = await fn(items[i]!)
    }
  }))
  return results
}
