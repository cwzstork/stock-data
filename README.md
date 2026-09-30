# 台股篩選器

上市 / 上櫃 / 興櫃的 47 欄篩選器，含即時報價。資料來自證交所、櫃買中心與 FinMind。

## 功能

| 頁面 | 內容 |
|---|---|
| `/` | 47 欄篩選器。條件存在網址上，可命名存起來、可匯出 CSV |
| `/live` | 即時報價（證交所 MIS，約延遲 20 秒）。中文模糊搜尋＋多選 |
| `/api/export` | 同條件的 CSV 匯出，含 BOM，Excel 直接開 |
| `/api/search` | 股票搜尋，給多選器用 |

欄位分六類：日頻行情、季頻財報（單季／累計／近四季／年增率）、配息、
年度彙總與便宜價、內部人持股、識別欄位。
**每個欄位名都標出時間基準**——`毛利率(累計6個月)%`、`ROE(近四季12個月)%`、
`負債比(2026-06-30)%`、`董監持股(2026-08)%`。

完整欄位說明見 [`docs/欄位說明.html`](docs/欄位說明.html)（單機開啟，無外部相依）。

## 架構

| 層 | 用什麼 | 免費額度 |
|---|---|---|
| 前端 / 後端 | Next.js 16（App Router，幾乎全 server component） | — |
| 資料庫 | Neon PostgreSQL 18 | 0.5 GB |
| 日頻明細 | Parquet on GitHub Release | 單檔 2 GB，不計入 repo |
| 每日同步 / 歷史回補 | GitHub Actions | 公開 repo 免費 |
| 部署 | Vercel | Hobby（個人非商業用途） |

```
src/
  app/
    page.tsx              篩選器
    live/page.tsx         即時報價
    api/export/route.ts   CSV 匯出
    api/search/route.ts   股票搜尋
  components/
    StockPicker.tsx       多選器（唯一的 client component）
  lib/
    prisma.ts             PrismaClient（延遲初始化 + driver adapter）
    screener.ts           篩選條件解析與查詢組裝
    saved-filter.ts       條件儲存器（server actions）
    twse.ts               證交所／櫃買 open API
    mops.ts               季頻財報（證交所口徑，目前未使用）
    finmind.ts            FinMind API
    live.ts               證交所 MIS 即時報價
    parquet.ts            日頻明細轉 Parquet（DuckDB）
    http.ts               帶重試的 fetch、併發限制
scripts/
  sync.ts                 每日同步
  backfill.ts             逐檔歷史回補（三個資料集）
```

## 資料來源

**日頻全市場**走證交所／櫃買中心官方 open API：免 token、無請求上限，
9 次呼叫拿到全市場一天。

**逐檔歷史**走 FinMind。免費的 register 層擋掉「不帶 `data_id` 的全市場查詢」，
但帶 `data_id` 時一次呼叫就拿到該檔十年份，所以逐檔其實很划算。

**季頻財報**只用 FinMind，不用證交所那份——兩者口徑不同（證交所是累計、
FinMind 是單季），混進同一張表會變成一半累計一半單季而且看不出來；
加上證交所那份在金控與保險業有欄位錯位的問題。

**沒有免費來源**：EPS（法人估）、最悲觀 EPS（法人估）。

## 設計原則

- **時間是鍵，不是欄位名**。不會出現 `close_20260924`；日期存在 `trade_date`，查詢時當參數傳。
- **存最細的粒度，粗的現算**。財報存單季，累計與近四季查詢時加總——
  單季能往上推導，累計反過來不行（缺任何一期就算不出單季）。
- **資料庫存原始單位**。股本存元、成交量存股，單位換算只在畫面最外層做。
- **篩選條件放在 URL**。網址可加書籤、可分享，每次打開都用當下資料重跑；
  存結果才會過期。要留快照就下載 CSV。
- **缺值是 null 不是 0**。本益比 0 的意思是「沒有意義」不是「最便宜」，
  不濾掉的話「近 N 年最低本益比」會全部變成 0。

## 本機開發

```bash
npm install
# 建 .env，填入下方「環境變數」
npx prisma migrate deploy
npm run sync -- --commit
npm run dev
```

## 指令

```bash
npm run sync                  乾跑：在交易中跑完所有 INSERT 再 rollback
npm run sync -- --commit      每日同步（主檔、日頻、股本、內部人持股）

npm run backfill              乾跑
npm run backfill -- --commit                      自動挑還沒補完的資料集
npm run backfill -- --commit --dataset=quarterly  指定資料集
npm run backfill -- --commit '--stocks=2330,0056' 指定股票
```

乾跑不是「只印不做」——它會真的執行 SQL、驗證型別與外鍵、回報實際落地的筆數，
然後整筆回滾。

> **PowerShell 的 `--stocks` 一定要加引號。** 不加的話 PowerShell 會把逗號串
> 當成陣列、把 `0056` 當數字，實際傳進去變成 `2330,56,878`。這不會報錯，
> 只會安靜地查錯股票，而台股 ETF 代號全靠前導零。

## 自動化

| Workflow | 排程 | 做什麼 |
|---|---|---|
| `sync.yml` | 每個交易日 18:00（台北） | 主檔、當日行情、股本、內部人持股 |
| `backfill.yml` | 每 6 小時（`7 */6 * * *`） | 逐檔回補，單輪跑滿 4.7 小時 |

回補依序處理三個資料集：**配息 → 年度彙總 → 十年季報**，
進度記在 `backfill_log`，中斷可續跑。

> GitHub 的排程是盡力而為，整點與半點最壅塞，高負載時會延遲甚至整個丟棄。
> 實測原本設每小時 `:30` 連續三小時一次都沒觸發。改成每 6 小時、分鐘選 `:07`，
> 並讓單輪跑滿——觸發次數少一個數量級，錯過一次的代價也小得多。

需要的 GitHub Secrets：`DATABASE_URL`（Neon pooled）、`FINMIND_TOKEN`。
`DIRECT_URL` 不用設——那是 migrate 才要的，`prisma generate` 不需要連資料庫。

## 部署到 Vercel

1. <https://vercel.com/new> → 匯入這個 repo，框架自動偵測為 Next.js
2. 展開 **Environment Variables**，加入 `DATABASE_URL`、`DIRECT_URL`、`FINMIND_TOKEN`
3. Deploy

`vercel.json` 把函式區域釘在 `sin1`（新加坡），因為 Neon 開在 `ap-southeast-1`。
不設的話預設落在美東，每次查詢多繞一趟太平洋。

建置不需要資料庫連線（`src/lib/prisma.ts` 是延遲初始化），環境變數漏了也不會
build 失敗，只會在開頁面時才報 `DATABASE_URL 未設定`。

> Neon 免費層閒置一段時間後會自動休眠，休眠後第一次開頁面會多等一下。

## 環境變數

| 名稱 | 用途 |
|---|---|
| `DATABASE_URL` | 執行期連線，**pooled**（host 含 `-pooler`）。走 Prisma driver adapter |
| `DIRECT_URL` | `prisma migrate` 專用，**direct**。走 pooler 會因為拿不到 advisory lock 而失敗 |
| `FINMIND_TOKEN` | FinMind API token |
| `PARQUET_DIR` | 回補時把日頻明細寫成 Parquet 的資料夾。沒設就跳過 |

`.env` 已被 `.gitignore` 排除。這個 repo 是公開的，任何金鑰都不要進版控。

## 資料表

| 表 | 內容 | 主鍵 |
|---|---|---|
| `stock` | 股票主檔（市場別、產業別） | `stock_id` |
| `stock_daily` | 日頻行情與評價 | `stock_id, trade_date` |
| `stock_quarterly` | 季頻財報，**存單季** | `stock_id, period_end` |
| `stock_dividend` | 逐筆除息紀錄（含 ETF） | `stock_id, ex_date` |
| `stock_annual` | 年度彙總（年均價、年高低、年均／最低 PER） | `stock_id, year` |
| `stock_capital` | 股本與已發行股數。只在數值變動時才寫新列 | `stock_id, report_date` |
| `stock_insider` | 內部人持股（董監／經理人／大股東） | `stock_id, period_end` |
| `saved_filter` | 存起來的篩選條件 | `id` |
| `backfill_log` | 逐檔回補進度 | `stock_id, dataset` |

### 幾個對位規則

**財報**：嚴格 `period_end <= trade_date`。用交易日之後才公告的財報去篩，
等於看未來資料。

**股本**：優先取 `report_date <= trade_date` 最接近的一筆，沒有才取之後最接近的。
因為公司基本資料的出表日常比交易日晚（2026-09-28 出表對應 2026-09-24 行情），
只寫 `<=` 的話最新一天會完全對不到。

**內部人持股**：嚴格 `period_end <= trade_date`。只有當期資料，切到歷史日期會空白。

**基準日下拉**：只列「有上市資料、有本益比、且檔數達最佳日期四分之一」的日子。
三個市場的 API 更新時間不一致，而回補是逐檔進行的，不過濾的話會混進大量
只有兩三檔的日期。選項上會標出該日的涵蓋檔數。

## 日頻明細（Parquet on GitHub Release）

十年逐日全放進資料庫要 690 萬列、超過 1 GB，撞爆免費層 0.5 GB。
資料庫只留**每月最後交易日 120 期 ＋ 最近 61 個交易日**，完整逐日外存 Parquet。

實測一檔十二年（2,860 列）：JSON 364 KB → Parquet(ZSTD) 39–59 KB，
全市場約 150 MB。檔案由 `annual` 回補順手產生——**不額外打任何一次 API**，
日頻資料本來就為了算年度彙總抓進來了。

檔名就是股號，上傳用 `--clobber`，重跑會覆蓋同名 asset，不會累積重複。

### 怎麼查

不用下載整包，DuckDB 可以直接查單一網址：

```sql
INSTALL httpfs; LOAD httpfs;

SELECT date, close, volume
  FROM 'https://github.com/cwzstork/stock-data/releases/download/daily-parquet/2330.parquet'
 WHERE date >= '2020-01-01'
 ORDER BY date;
```

掃多檔就先拉下來：

```bash
gh release download daily-parquet -D parquet -p '*.parquet'
```

```sql
SELECT stock_id, count(*), round(avg(close), 2) FROM 'parquet/*.parquet' GROUP BY 1;
```

欄位：`date DATE, stock_id VARCHAR, open/high/low/close DOUBLE, volume/turnover BIGINT`。

> 目前是「按股票」分檔，查單檔十年只要開 1 個檔，
> 但查「2018-01-24 全市場」要開 3,081 個檔。
> 全市場歷史掃描需要另做一套按年分檔的佈局。

## 狀態與待辦

見 [`docs/欄位說明.html`](docs/欄位說明.html) 的第四、五節，裡面有回補進度、
各欄位的實際涵蓋區間、以及容量規劃。
