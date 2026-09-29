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
 *   3,081 檔約 83 MB。而且 Parquet 是列式的，查單一欄位或單一時段
 *   不用讀整個檔——DuckDB 可以只抓需要的那幾個 row group。
 *
 * 為什麼放 GitHub Release：
 *   不計入 repo 大小（clone 不會變慢）、單檔上限 2 GB、不需要另開帳號
 *   或綁信用卡。而且 asset 有穩定的公開網址，DuckDB 的 httpfs 可以直接查，
 *   不必先下載整包。
 *
 * 為什麼一檔一個檔案：
 *   抓取本來就逐檔進行，可中斷續跑；檔名就是股號，重跑會覆蓋同名 asset，
 *   所以永遠不會出現重複資料。實際查詢也多半是「看某一檔的十年走勢」，
 *   直接指向那一個網址就好，不用掃全市場。
 *
 * 沒有設定 PARQUET_DIR 時整支會安靜跳過，不影響其他回補。
 */

import type { DuckDBConnection } from '@duckdb/node-api';

/** 產生的檔案要放哪。由 workflow 指定，之後那一步再一次上傳。 */
export function readParquetDir(): string | null {
  return process.env.PARQUET_DIR || null;
}

let conn: DuckDBConnection | null = null;

async function getConnection(): Promise<DuckDBConnection> {
  if (conn) return conn;
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  conn = await instance.connect();
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

/**
 * 把一檔的日頻明細寫成 Parquet。
 *
 * 走 read_json_auto 讀一個暫存的 NDJSON，而不是逐列 INSERT——
 * 兩千多列逐列插入會慢上兩個數量級，而且 DuckDB 對 JSON 的型別推斷
 * 正好能把 date 認成 DATE、量能認成 BIGINT。
 */
export async function writeDailyParquet(
  dir: string,
  stockId: string,
  rows: DailyBar[],
): Promise<{ path: string; rows: number; bytes: number }> {
  const { writeFileSync, rmSync, mkdtempSync, mkdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'pq-'));
  // DuckDB 的路徑一律用正斜線，Windows 的反斜線會被當成跳脫字元
  const jsonPath = join(tmp, 'in.json').replace(/\\/g, '/');
  const outPath = join(dir, `${stockId}.parquet`).replace(/\\/g, '/');

  try {
    writeFileSync(
      jsonPath,
      rows
        .map((r) =>
          JSON.stringify({
            date: r.date,
            stock_id: r.stock_id,
            open: r.open,
            high: r.max,
            low: r.min,
            close: r.close,
            volume: r.Trading_Volume,
            turnover: r.Trading_money,
          }),
        )
        .join('\n'),
    );

    const c = await getConnection();
    await c.run(
      `COPY (SELECT * FROM read_json_auto('${jsonPath}') ORDER BY date)
         TO '${outPath}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
    return { path: outPath, rows: rows.length, bytes: statSync(outPath).size };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
