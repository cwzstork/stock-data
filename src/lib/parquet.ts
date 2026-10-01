/**
 * 日頻明細外存成 Parquet，放 GitHub Release。
 *
 * 為什麼不進資料庫：
 *   3,081 檔 × 每年約 245 個交易日 × 10 年 ≈ 690 萬列，含索引超過 1 GB，
 *   撞爆 Neon 免費層 0.5 GB。而篩選器要的指標只需要年度層級
 *   （已經在 stock_annual），日頻明細只有畫走勢圖或回測才會用到。
 *
 * 為什麼是 Parquet 而不是 JSON／CSV：
 *   實測同一檔十年日頻，JSON 364 KB、Parquet(ZSTD) 28 KB，壓縮 13.2 倍。
 *   而且 Parquet 是列式的，查單一欄位或單一時段不用讀整個檔——
 *   DuckDB 可以只抓需要的那幾個 row group。
 *
 * 為什麼放 GitHub Release：
 *   不計入 repo 大小（clone 不會變慢）、單檔上限 2 GB、不需要另開帳號
 *   或綁信用卡。而且 asset 有穩定的公開網址，DuckDB 的 httpfs 可以直接查，
 *   不必先下載整包。
 *
 * ── 為什麼改成一年一個檔（原本是一檔股票一個檔）──────────────
 *
 * 原本檔名就是股號，重跑會覆蓋同名 asset，天然不會重複。
 * 但 GitHub 每個 Release 最多只能有 1,000 個 asset，3,081 檔放不下——
 * 實測補到第 1,000 個（3567.parquet）就被擋，之後每一輪上傳都失敗
 * （job 紅燈，但資料庫的部分是好的）。
 *
 * 改成一年一個檔之後：
 *   檔案數 12 個，離上限很遠；每檔約 12 MB，離單檔 2 GB 也很遠。
 *   順便解掉「查某一天的全市場要開 3,081 個檔」的問題——現在只要開 1 個。
 *   查單一檔股票變成要開 12 個檔，但 Parquet 有 row group 統計，
 *   加上 stock_id 的條件就會跳過絕大多數 row group，不會真的掃完。
 *
 * 代價是不能再「一檔寫完就上傳」，所以流程改成兩段：
 *   1. 逐檔抓到的列先累積成每年一個 NDJSON（appendDaily）
 *   2. 整輪結束時跟 Release 上既有的年度檔合併後輸出（finalizeYears）
 *
 * 合併時用 stock_id 做反向比對：這一輪重抓過的股票，舊檔裡的那些列
 * 整批換掉而不是疊加，所以同一檔重跑幾次都不會產生重複列。
 *
 * 沒有設定 PARQUET_DIR 時整支會安靜跳過，不影響其他回補。
 */

import type { DuckDBConnection } from '@duckdb/node-api';

/** 產生的檔案要放哪。由 workflow 指定，之後那一步再一次上傳。 */
export function readParquetDir(): string | null {
  return process.env.PARQUET_DIR || null;
}

/**
 * 既有年度檔的網址前綴。設了才會做合併；沒設就只輸出這一輪抓到的，
 * 等於整包重建。
 */
export function readParquetBaseUrl(): string | null {
  return process.env.PARQUET_BASE_URL || null;
}

let conn: DuckDBConnection | null = null;

async function getConnection(): Promise<DuckDBConnection> {
  if (conn) return conn;
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  conn = await instance.connect();
  // 讀遠端年度檔要 httpfs。沒裝成功也不該讓整段爆掉——
  // 合併那一步自己會因為讀不到而退回「只輸出這一輪」。
  try {
    await conn.run('INSTALL httpfs');
    await conn.run('LOAD httpfs');
  } catch {
    // 忽略：不能合併遠端檔而已，不是致命錯誤
  }
  return conn;
}

export interface DailyBar {
  date: string;
  stock_id: string;
  open: number;
  max: number;
  min: number;
  close: number;
  Trading_Volume: number;
  Trading_money: number;
}

/** DuckDB 的路徑一律用正斜線，Windows 的反斜線會被當成跳脫字元 */
const fwd = (p: string) => p.split("\\").join("/");

/**
 * 把一檔的日頻明細附加到「每年一個」的暫存 NDJSON。
 *
 * 用 NDJSON 而不是逐列 INSERT 進 DuckDB：兩千多列逐列插入會慢兩個數量級，
 * 而 read_json_auto 正好能把 date 認成 DATE、量能認成 BIGINT。
 */
export async function appendDaily(
  dir: string,
  rows: DailyBar[],
): Promise<{ rows: number; years: number }> {
  const { appendFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');

  mkdirSync(dir, { recursive: true });

  const byYear = new Map<string, string[]>();
  for (const r of rows) {
    const year = r.date.slice(0, 4);
    const line = JSON.stringify({
      date: r.date,
      stock_id: r.stock_id,
      open: r.open,
      high: r.max,
      low: r.min,
      close: r.close,
      volume: r.Trading_Volume,
      turnover: r.Trading_money,
    });
    const bucket = byYear.get(year);
    if (bucket) bucket.push(line);
    else byYear.set(year, [line]);
  }

  for (const [year, lines] of byYear) {
    appendFileSync(join(dir, `${year}.ndjson`), lines.join('\n') + '\n');
  }

  return { rows: rows.length, years: byYear.size };
}

export interface YearFile {
  year: string;
  path: string;
  rows: number;
  bytes: number;
  merged: boolean;
}

/**
 * 把這一輪累積的 NDJSON 寫成每年一個 Parquet，並與 Release 上既有的合併。
 *
 * 合併規則：這一輪重抓過的股票，舊檔裡屬於它們的列整批丟掉再換成新的。
 * 不是「union 全部」——那樣同一檔重跑一次就會多出一份重複的列。
 */
export async function finalizeYears(dir: string, baseUrl: string | null): Promise<YearFile[]> {
  const { readdirSync, statSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');

  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  } catch {
    return [];
  }
  if (names.length === 0) return [];

  const c = await getConnection();
  const out: YearFile[] = [];

  for (const name of names.sort()) {
    const year = name.replace('.ndjson', '');
    const jsonPath = fwd(join(dir, name));
    const outPath = fwd(join(dir, `${year}.parquet`));
    const remote = baseUrl ? `${baseUrl.replace(/\/$/, '')}/${year}.parquet` : null;

    const newOnly = `SELECT * FROM read_json_auto('${jsonPath}')`;
    // UNION ALL BY NAME 用欄位名對齊，日後加欄位時舊檔少一欄也不會整個失敗
    const sql = remote
      ? `WITH fresh AS (${newOnly})
         SELECT * FROM fresh
         UNION ALL BY NAME
         SELECT * FROM '${remote}'
          WHERE stock_id NOT IN (SELECT stock_id FROM fresh)`
      : newOnly;

    let didMerge = Boolean(remote);
    try {
      await c.run(
        `COPY (SELECT * FROM (${sql}) ORDER BY date, stock_id)
           TO '${outPath}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
      );
    } catch (e) {
      // 遠端檔不存在（第一次跑）或讀不到時退回只輸出這一輪的。
      // 不能因此中止——那會讓整輪五小時的抓取白做。
      if (!remote) throw e;
      console.warn(
        `      ! ${year} 讀不到既有年度檔，改成只輸出這一輪: ${e instanceof Error ? e.message : e}`,
      );
      didMerge = false;
      await c.run(
        `COPY (SELECT * FROM (${newOnly}) ORDER BY date, stock_id)
           TO '${outPath}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
      );
    }

    const counted = (
      await c.runAndReadAll(`SELECT count(*)::bigint AS n FROM '${outPath}'`)
    ).getRowObjects() as unknown as { n: bigint }[];

    out.push({
      year,
      path: outPath,
      rows: Number(counted[0]?.n ?? 0),
      bytes: statSync(outPath).size,
      merged: didMerge,
    });
    // NDJSON 是中間產物，留著會被 workflow 當成要上傳的檔案
    rmSync(join(dir, name), { force: true });
  }

  return out;
}
