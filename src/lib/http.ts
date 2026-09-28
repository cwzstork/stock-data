/**
 * 帶重試的 fetch。
 *
 * 為什麼需要：官方 open API 偶發會在 TLS 層直接斷線（ECONNRESET），
 * 上櫃那支回應 4MB 以上更容易踩到。本機重跑一次就好，
 * 但排成每日 cron 之後，一次偶發斷線就會讓整天的資料沒進來。
 *
 * 只重試「重試有機會成功」的情況：網路層錯誤與 5xx。
 * 4xx 是請求本身有問題（權限、參數），重試只是浪費額度。
 * 402 / 429 由呼叫端自己處理，因為那要退避得更久。
 */

const RETRYABLE_STATUS = new Set([408, 425, 500, 502, 503, 504]);

export interface RetryOptions {
  /** 總嘗試次數（含第一次） */
  attempts?: number;
  /** 單次請求逾時（毫秒） */
  timeoutMs?: number;
  /** 印在重試訊息裡的名稱 */
  label?: string;
}

export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit = {},
  { attempts = 4, timeoutMs = 60_000, label = String(url) }: RetryOptions = {},
): Promise<Response> {
  let lastError: unknown;

  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!RETRYABLE_STATUS.has(res.status) || i === attempts) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
      if (i === attempts) break;
    }

    const waitMs = 2 ** (i - 1) * 1_000;
    const reason = lastError instanceof Error ? (lastError.cause ?? lastError).toString() : String(lastError);
    console.warn(`  [retry ${i}/${attempts - 1}] ${label}: ${reason}，${waitMs / 1000}s 後重試`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  throw new Error(`${label} 連續 ${attempts} 次失敗`, { cause: lastError });
}
