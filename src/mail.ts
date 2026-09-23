export interface Search {
  text?: string;
  query?: string;
  limit?: number;
  pageToken?: string;
}
export interface Summary {
  id: string;
  threadId?: string;
  subject?: string;
  from?: string;
  date?: string;
  snippet?: string;
  unread?: boolean;
}
export interface Page {
  messages: Summary[];
  nextPageToken?: string;
}
export interface MailProvider {
  list(input: Search): Promise<Page>;
  get(id: string): Promise<unknown>;
}

export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const i = index;
        index += 1;
        results[i] = await fn(items[i] as T);
      }
    })
  );
  return results;
}
