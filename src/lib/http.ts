/**
 * 帶重試的 JSON 取得。
 *
 * 為什麼一定要把「讀 body」也包進重試裡：
 *   fetch() 在 response headers 到達時就 resolve 了，body 是之後才串流下來的。
 *   連線在傳 body 的過程中被切斷，會在 res.json() 那一步才丟出
 *     TypeError: terminated  { cause: Error: read ECONNRESET }
 *   如果只把 fetch() 包在重試裡、body 在外面讀，這種錯誤完全攔不到。
 *   實測上櫃那支 4MB 的回應最容易踩到。
 *
 * 只重試「重試有機會成功」的情況：網路層錯誤、body 中斷、以及 5xx。
 * 4xx 是請求本身有問題（權限、參數），重試只是浪費額度。
 */

const DEFAULT_RETRY_STATUS = [408, 425, 500, 502, 503, 504];

export interface FetchJsonOptions {
  /** 印在重試訊息裡的名稱 */
  label?: string;
  /** 總嘗試次數（含第一次） */
  attempts?: number;
  /** 單次請求逾時（毫秒）。含讀完 body 的時間。 */
  timeoutMs?: number;
  /** 額外要重試的狀態碼，例如 FinMind 的額度限制 */
  retryStatus?: number[];
  /** 退避基數（毫秒）。額度類的錯誤要等久一點才有意義。 */
  backoffMs?: number;
  headers?: Record<string, string>;
}

export interface JsonResponse<T> {
  status: number;
  ok: boolean;
  body: T;
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : null;
    return code ? `${e.message} (${code})` : e.message;
  }
  return String(e);
}

export async function fetchJson<T>(
  url: string | URL,
  {
    label = String(url),
    attempts = 4,
    timeoutMs = 60_000,
    retryStatus = [],
    backoffMs = 1_000,
    headers = { accept: 'application/json' },
  }: FetchJsonOptions = {},
): Promise<JsonResponse<T>> {
  const retryable = new Set([...DEFAULT_RETRY_STATUS, ...retryStatus]);
  let lastError: unknown;

  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });

      if (retryable.has(res.status) && i < attempts) {
        lastError = new Error(`HTTP ${res.status}`);
      } else {
        // 非 2xx 也要把 body 讀出來——錯誤訊息通常就在裡面
        const text = await res.text();
        let body: T;
        try {
          body = JSON.parse(text) as T;
        } catch {
          if (res.ok) throw new Error(`回應不是合法 JSON：${text.slice(0, 200)}`);
          body = {} as T;
        }
        return { status: res.status, ok: res.ok, body };
      }
    } catch (e) {
      lastError = e;
      if (i === attempts) break;
    }

    const waitMs = backoffMs * 2 ** (i - 1);
    console.warn(`  [retry ${i}/${attempts - 1}] ${label}: ${describe(lastError)}，${waitMs / 1000}s 後重試`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  throw new Error(`${label} 連續 ${attempts} 次失敗：${describe(lastError)}`, { cause: lastError });
}

/**
 * 限制同時進行的數量。
 *
 * 一次把二三十個請求全丟出去，對方或中間的代理很容易直接切連線，
 * 而且切的是 body 傳輸中的那幾條，看起來就像隨機失敗。
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return out;
}
