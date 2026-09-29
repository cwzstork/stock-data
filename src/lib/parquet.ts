/**
 * 日頻明細外存成 Parquet，放 Cloudflare R2。
 *
 * 為什麼不進資料庫：
 *   3,081 檔 × 每年約 245 個交易日 × 10 年 ≈ 690 萬列，含索引超過 1 GB，
 *   撞爆 Neon 免費層 0.5 GB。而篩選器要的指標只需要年度層級
 *   （已經在 stock_annual），日頻明細只有畫走勢圖或回測才會用到。
 *
 * 為什麼是 Parquet 而不是 JSON／CSV：
 *   實測同一檔十年日頻，JSON 364 KB、Parquet(ZSTD) 28 KB，壓縮 13.2 倍。
 *   3,081 檔約 83 MB，R2 免費層有 10 GB。
 *   而且 Parquet 是列式的，查單一欄位或單一時段不用讀整個檔。
 *
 * 為什麼一檔一個檔案：
 *   抓取本來就是逐檔進行，一檔一檔寫可以中斷續跑，不必先把全市場
 *   累積在記憶體裡。實際查詢也多半是「看某一檔的十年走勢」。
 *   之後真要做全市場掃描，再用 DuckDB 把它們壓成按年分區的大檔即可。
 *
 * 沒有設定 R2 時整支會安靜跳過，不影響其他回補。
 */

import type { DuckDBConnection } from '@duckdb/node-api';

export interface R2Config {
  accountId: string;
  keyId: string;
  secret: string;
  bucket: string;
  /** 物件路徑前綴，預設 daily */
  prefix: string;
}

export function readR2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const keyId = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !keyId || !secret || !bucket) return null;
  return { accountId, keyId, secret, bucket, prefix: process.env.R2_PREFIX ?? 'daily' };
}

let conn: DuckDBConnection | null = null;

/**
 * 建立 DuckDB 連線並掛上 R2 認證。
 *
 * DuckDB 的 httpfs 擴充原生支援 r2:// 協定，所以不需要另外裝 AWS SDK，
 * 產生 Parquet 與上傳可以在同一句 COPY 完成。
 */
async function getConnection(cfg: R2Config): Promise<DuckDBConnection> {
  if (conn) return conn;
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  const c = await instance.connect();
  await c.run('INSTALL httpfs; LOAD httpfs;');
  // 這裡會帶到金鑰，所以用參數化；DuckDB 的 CREATE SECRET 不吃 prepared statement，
  // 改用 escape 後內嵌，金鑰本身是 base64/hex 字元集，不含單引號
  const esc = (v: string) => v.replace(/'/g, "''");
  await c.run(`CREATE OR REPLACE SECRET r2_secret (
    TYPE R2,
    KEY_ID '${esc(cfg.keyId)}',
    SECRET '${esc(cfg.secret)}',
    ACCOUNT_ID '${esc(cfg.accountId)}'
  )`);
  conn = c;
  return c;
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
 * 把一檔的日頻明細寫成 Parquet 上傳 R2。
 *
 * 走 read_json_auto 讀一個暫存的 NDJSON，而不是逐列 INSERT——
 * 兩千多列逐列插入會慢上兩個數量級，而且 DuckDB 對 JSON 的型別推斷
 * 正好能把 date 認成 DATE、量能認成 BIGINT。
 */
export async function uploadDailyParquet(
  cfg: R2Config,
  stockId: string,
  rows: DailyBar[],
): Promise<{ key: string; rows: number }> {
  const { writeFileSync, rmSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const dir = mkdtempSync(join(tmpdir(), 'pq-'));
  const jsonPath = join(dir, 'in.json').replace(/\\/g, '/');
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

    const c = await getConnection(cfg);
    const key = `${cfg.prefix}/${stockId}.parquet`;
    await c.run(
      `COPY (SELECT * FROM read_json_auto('${jsonPath}') ORDER BY date)
         TO 'r2://${cfg.bucket}/${key}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
    return { key, rows: rows.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
