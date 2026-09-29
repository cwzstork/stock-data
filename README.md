# 台股篩選器

上市 / 上櫃 / 興櫃的行情與評價指標篩選。資料來自證交所與櫃買中心的官方 open API。

## 架構

| 層 | 用什麼 | 免費額度 |
|---|---|---|
| 前端 / 後端 | Next.js 16（App Router，全 server component） | — |
| 資料庫 | Neon PostgreSQL 18 | 0.5 GB |
| 同步 | `scripts/sync.ts` | — |
| 部署 | Vercel | Hobby（個人非商業用途） |

### 資料來源

日頻全市場資料走**證交所 / 櫃買中心官方 open API**：免 token、無請求上限，9 次呼叫拿到全市場一天。

FinMind 只用來抓股票主檔（`TaiwanStockInfo`）。免費的 register 層擋掉「不帶 `data_id` 的全市場查詢」，
`TaiwanStockPrice` 這類要逐檔打 3,000+ 次才拿得到一天，額度不可能夠。

股本來自公司基本資料的「實收資本額」，上市櫃興櫃三個市場都有，不必逐檔抓資產負債表。

### 設計原則

- **時間是鍵，不是欄位名**。不會出現 `close_20260924` 這種欄位；日期存在 `trade_date`，查詢時當參數傳。
- **滾動彙總查詢時現算**，不落地。N 年平均／最低用視窗函數算。
- **資料庫一律存原始單位**（股本存元、成交量存股），單位換算只在畫面最外層做。
- **篩選條件放在 URL，不存資料庫**。網址可加書籤、可分享，每次打開都是用當下資料重跑；
  存結果才會過期——今天存的清單，明天股價變了就不準。要留快照就按「下載 CSV」。

## 本機開發

```bash
npm install
# 建 .env，填入下方「環境變數」那三個
npx prisma migrate deploy
npm run sync -- --commit
npm run dev
```

## 同步資料

```bash
npm run sync               # 乾跑：在交易中跑完所有 INSERT 再 rollback，資料庫不留痕跡
npm run sync -- --commit   # 實際寫入
```

乾跑不是「只印不做」——它會真的執行 SQL、驗證型別與外鍵、回報實際落地的筆數，然後整筆回滾。

官方 open API 只提供「最新一個交易日」，不吃日期參數，所以這支腳本適合每日增量。
歷史回補要另外走帶日期參數的舊版報表 API。

### 每日自動同步

`.github/workflows/sync.yml` 每個交易日 18:00（台北）跑一次，也可以在 Actions 分頁手動觸發。

需要在 repo 的 Settings → Secrets and variables → Actions 設兩個 secret：

| Secret | 值 |
|---|---|
| `DATABASE_URL` | Neon 的 pooled 連線字串 |
| `FINMIND_TOKEN` | FinMind token |

`DIRECT_URL` 不用設——那是 migrate 才要的，`prisma generate` 不需要連資料庫。

幾個已知行為：

- GitHub 的排程常誤點十幾分鐘到半小時，這個用途不需要精準
- 遇到休市日照跑，但同步是 upsert，只會把同一天的資料重寫一次，不會壞
- **公開 repo 超過 60 天沒有新 commit，GitHub 會自動停用排程**，要進 Actions 分頁手動重新啟用

## 部署到 Vercel

1. <https://vercel.com/new> → 匯入這個 GitHub repo，框架會自動偵測為 Next.js
2. 展開 **Environment Variables**，加入下方三個
3. Deploy

`vercel.json` 把函式區域釘在 `sin1`（新加坡），因為 Neon 開在 `ap-southeast-1`。
不設的話預設會落在美東，每次查詢多繞一趟太平洋。

建置不需要資料庫連線（`src/lib/prisma.ts` 是延遲初始化），所以環境變數漏了也不會 build 失敗，
只會在開頁面時才報 `DATABASE_URL 未設定`。

> Neon 免費層閒置一段時間後會自動休眠，休眠後第一次開頁面會多等一下才醒來。

## 環境變數

| 名稱 | 用途 |
|---|---|
| `DATABASE_URL` | 執行期連線，**pooled**（host 含 `-pooler`）。走 Prisma driver adapter |
| `DIRECT_URL` | `prisma migrate` / `introspect` 專用，**direct**（host 不含 `-pooler`）。走 pooler 會因為拿不到 advisory lock 而失敗 |
| `FINMIND_TOKEN` | FinMind API token |

`.env` 已被 `.gitignore` 排除。這個 repo 是公開的，任何金鑰都不要進版控。

## 資料表

| 表 | 內容 | 主鍵 |
|---|---|---|
| `stock` | 股票主檔（市場別、產業別） | `stock_id` |
| `stock_daily` | 日頻行情與評價（收盤、量額、殖利率、本益比、股價淨值比） | `stock_id, trade_date` |
| `stock_capital` | 股本。只在數值變動時才寫新列，否則每日同步會讓它跟日頻一樣大 | `stock_id, report_date` |
| `stock_quarterly` | 季頻財報（損益表＋資產負債表） | `stock_id, period_end` |

`stock_capital.report_date` 是資料出表日，不是交易日，而且往往比交易日還晚。
所以查詢時是「優先取交易日當天或之前最接近的一筆，真的沒有才取之後最接近的」——
只寫 `report_date <= trade_date` 的話最新一天會完全對不到。

`stock_quarterly` 的對位規則刻意相反：**嚴格只取 `period_end <= 交易日`**。
用交易日之後才公告的財報去篩，是看未來資料，篩出來的結果在當下根本不可能知道。

### 財報的兩個陷阱

**損益表是累計數**，Q2 是上半年累計不是單季；資產負債表則是期末時點數，不能相減。
畫面上的 ROE 已乘以 `4 / 季別` 年化，才能跟「ROE > 15%」這種條件對得上。
這是近似，旺淡季不均的公司會失真，等十年歷史補完會改用近四季。

**不是每個行業的欄位都能用。** 證交所把財報依行業拆成六個檔，欄位結構各不相同，
而且其中兩類的資料本身有問題（2026-09-29 逐一驗算）：

| 行業別 | 驗算方式 | 結果 |
|---|---|---|
| `ci` 一般業 | 台積電 EPS 與每股淨值用股本反算 | 完全吻合，全部可用 |
| `mim` 異業 | 收入 − 支出 = 稅前 | 四家全中 |
| `bd` 證券期貨 | 收益 − 支出及費用 = 營業利益 | 三家全中 |
| `basi` 銀行 | 利息淨收益＋利息以外淨損益−呆帳−營業費用 = 稅前 | 完全吻合（但銀行沒有單一營收概念，`revenue` 留空）|
| `fh` 金控 | 「淨收益」對不上加總；13 家全部稅前 < 稅後 | **欄位錯位，只採用淨利與 EPS** |
| `ins` 保險 | 旺旺保營益 > 營收；中再保營益是營收 6 倍 | **營收與營業利益不可信，不採用** |

所以毛利率只有一般業算得出來，營益率多了證券期貨業，淨利率再多異業；
ROE／負債比／EPS／每股淨值則是所有行業都有。
寧可留白，也不要在畫面上放一個看起來像數字的錯誤值。

資產負債恆等式（資產總計 = 負債總計 + 權益總計）1,976 筆全數相符，可作為回歸檢查。
