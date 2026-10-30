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

const DEFAULT_RETRY_STATUS = [408, 425, 429, 500, 502, 503, 504];

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

// ── 節流防護 ─────────────────────────────────────────────────────

/**
 * 每個 host 同時最多幾條連線。
 *
 * 2026-10 那三次同步失敗是同一回事：sync 的 Promise.all 一口氣對兩個
 * 交易所發出 12 支請求（證交所 5、櫃買 7）。證交所回一頁 WAF 擋頁，
 * 櫃買在 body 傳到一半切線——兩邊都不是壞掉，是嫌我們太吵。
 *
 * 閘門放在這一層而不是各個呼叫點，因為 fan-out 是分散的：sync.ts 的
 * Promise.all 底下，fetchCompanyProfiles 自己又展開 3 支、
 * fetchInsiderHoldings 2 支、fetchMonthlyRevenue 2 支。
 * 只有在最底層數，數出來的才是真正同時在飛的數量。
 *
 * 沒列在表裡的 host 用 DEFAULT_HOST_LIMIT——Google、Yahoo 這種
 * 吃得下併發的對象沒必要跟著慢下來。
 */
const HOST_LIMIT: Record<string, number> = {
  'openapi.twse.com.tw': 2,
  'www.tpex.org.tw': 2,
};
const DEFAULT_HOST_LIMIT = 4;

/** 被節流後的退避基數。1/2/4 秒三次全落在同一個封鎖窗裡，等於沒等。 */
const THROTTLE_BACKOFF_MS = 15_000;

/**
 * 證交所擋下請求時回的那一頁。
 *
 * 關鍵在於它是 HTTP 200 + 一頁 HTML，retryStatus 那一關永遠攔不到，
 * 只會在 JSON.parse 失敗時以「回應不是合法 JSON」的面貌出現，
 * 看起來像上游改了格式，其實是我們被擋了。
 */
const WAF_MARKERS = ['FOR SECURITY REASONS', '因為安全性考量'];

interface HostState {
  active: number;
  waiting: (() => void)[];
  /** 整個 host 被擋下之後，要安靜到什麼時候 */
  quietUntil: number;
}

const hostStates = new Map<string, HostState>();

function gateOf(url: string | URL): { state: HostState; limit: number } {
  let host: string;
  try {
    host = new URL(String(url)).host;
  } catch {
    host = String(url);
  }
  let state = hostStates.get(host);
  if (!state) {
    state = { active: 0, waiting: [], quietUntil: 0 };
    hostStates.set(host, state);
  }
  return { state, limit: HOST_LIMIT[host] ?? DEFAULT_HOST_LIMIT };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 取得名額。
 *
 * 冷卻是「佔著名額等」的：host 正在生氣的時候，讓後面的人排隊，
 * 比讓他們一起衝出去好。等完才真的發請求。
 */
async function acquire({ state, limit }: { state: HostState; limit: number }): Promise<void> {
  while (state.active >= limit) await new Promise<void>((r) => state.waiting.push(r));
  state.active += 1;
  for (let left = state.quietUntil - Date.now(); left > 0; left = state.quietUntil - Date.now()) {
    await sleep(left);
  }
}

function release(state: HostState): void {
  state.active -= 1;
  state.waiting.shift()?.();
}

/** 「上游嫌我們太吵」而不是「上游壞了」。這類要等久一點，而且不只這一支要等。 */
class ThrottleError extends Error {}

function wafBlocked(text: string): boolean {
  const head = text.slice(0, 500);
  return WAF_MARKERS.some((m) => head.includes(m));
}

/**
 * 連線在傳輸途中被對方切掉，跟 WAF 擋頁是同一件事的兩種長相：
 * 證交所給你一頁 HTML，櫃買直接把線拔掉。
 */
function isThrottle(e: unknown): boolean {
  if (e instanceof ThrottleError) return true;
  return /UND_ERR_SOCKET|ECONNRESET|ECONNABORTED|EPIPE|\bterminated\b/i.test(describe(e));
}

/** 退避時間。被節流時 1/2/4 秒沒有意義——封鎖窗比那長得多。 */
function backoffFor(e: unknown, attempt: number, baseMs: number): number {
  const base = isThrottle(e) ? Math.max(baseMs, THROTTLE_BACKOFF_MS) : baseMs;
  return base * 2 ** (attempt - 1);
}

/**
 * 標記整個 host 進入冷卻。
 *
 * 一定要在 release() 之前呼叫：先放掉名額、後標記冷卻的話，排在後面的
 * 請求會搶在標記完成前拿到名額衝出去，等於白擋。
 */
function markQuiet(state: HostState, failure: unknown, attempt: number, baseMs: number): void {
  if (!(failure instanceof ThrottleError)) return;
  state.quietUntil = Math.max(state.quietUntil, Date.now() + backoffFor(failure, attempt, baseMs));
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
  const gate = gateOf(url);
  let lastError: unknown;

  for (let i = 1; i <= attempts; i += 1) {
    // 這一輪自己的錯誤。不能直接用 lastError——成功收尾時 finally 會讀到
    // 上一輪留下的錯誤，害整個 host 被誤判成還在生氣。
    let failure: unknown;
    await acquire(gate);
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });

      if (retryable.has(res.status) && i < attempts) {
        failure =
          res.status === 429 ? new ThrottleError('HTTP 429') : new Error(`HTTP ${res.status}`);
      } else {
        // 非 2xx 也要把 body 讀出來——錯誤訊息通常就在裡面
        const text = await res.text();
        // 擋頁是 HTTP 200，只看狀態碼認不出來，一定要看 body
        if (wafBlocked(text)) throw new ThrottleError(`被上游擋下（HTTP ${res.status} 安全頁）`);
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
      failure = e;
    } finally {
      markQuiet(gate.state, failure, i, backoffMs);
      release(gate.state);
    }

    lastError = failure;
    if (i === attempts) break;

    const waitMs = backoffFor(failure, i, backoffMs);
    console.warn(`  [retry ${i}/${attempts - 1}] ${label}: ${describe(lastError)}，${waitMs / 1000}s 後重試`);
    await sleep(waitMs);
  }

  throw new Error(`${label} 連續 ${attempts} 次失敗：${describe(lastError)}`, { cause: lastError });
}

/**
 * 帶重試的純文字取得（RSS 用）。重試規則同 fetchJson：body 也包在重試裡、只重試 5xx 與網路錯誤。
 * 非 2xx 直接丟錯——RSS 沒有「錯誤訊息在 body 裡」這回事，回 200 以外就是拿不到。
 */
export async function fetchText(
  url: string | URL,
  { label = String(url), attempts = 3, timeoutMs = 30_000, backoffMs = 1_000, headers = {} }: FetchJsonOptions = {},
): Promise<string> {
  const retryable = new Set(DEFAULT_RETRY_STATUS);
  const gate = gateOf(url);
  let lastError: unknown;

  for (let i = 1; i <= attempts; i += 1) {
    let failure: unknown;
    let fatal = false;
    await acquire(gate);
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const text = await res.text();
        if (wafBlocked(text)) throw new ThrottleError(`被上游擋下（HTTP ${res.status} 安全頁）`);
        return text;
      }
      failure =
        res.status === 429 ? new ThrottleError('HTTP 429') : new Error(`HTTP ${res.status}`);
      fatal = !retryable.has(res.status);
    } catch (e) {
      failure = e;
    } finally {
      markQuiet(gate.state, failure, i, backoffMs);
      release(gate.state);
    }

    lastError = failure;
    if (fatal || i === attempts) break;

    const waitMs = backoffFor(failure, i, backoffMs);
    console.warn(`  [retry ${i}/${attempts - 1}] ${label}: ${describe(lastError)}，${waitMs / 1000}s 後重試`);
    await sleep(waitMs);
  }

  throw new Error(`${label}：${describe(lastError)}`, { cause: lastError });
}

/**
 * 限制同時進行的數量。
 *
 * 一次把二三十個請求全丟出去，對方或中間的代理很容易直接切連線，
 * 而且切的是 body 傳輸中的那幾條，看起來就像隨機失敗。
 *
 * 跟 HOST_LIMIT 是兩層不同的事：這裡限制「同時有幾件工作在跑」，
 * HOST_LIMIT 限制「同一個 host 同時有幾條連線」。一件工作底下可能再展開
 * 好幾支請求，也可能散落在不同 host，兩層都留著才蓋得住。
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
