-- 現金流量（單季）。上游給累計，寫入時相減轉成單季。
ALTER TABLE "stock_quarterly"
  ADD COLUMN "cf_operating" BIGINT,
  ADD COLUMN "cf_investing" BIGINT,
  ADD COLUMN "cf_financing" BIGINT,
  ADD COLUMN "capex"        BIGINT,
  ADD COLUMN "cash_end"     BIGINT;

-- backfill_log.synced_at 原本是 timestamp（無時區），讀回來固定差一個時區偏移。
-- 既有資料是用「本地時間當成 UTC」寫進去的，所以轉型時要用寫入端的時區還原。
-- GitHub runner 跑在 UTC，本機在 +08，兩種來源混在一起無法逐列判斷，
-- 而這一欄只用於顯示「最後更新時間」，不影響任何進度判斷，
-- 所以直接以 UTC 解讀既有值，之後寫入的才會完全正確。
ALTER TABLE "backfill_log"
  ALTER COLUMN "synced_at" TYPE TIMESTAMPTZ(3) USING "synced_at" AT TIME ZONE 'UTC';
