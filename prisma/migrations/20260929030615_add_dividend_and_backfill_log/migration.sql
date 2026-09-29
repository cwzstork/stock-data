-- CreateTable
CREATE TABLE "stock_dividend" (
    "stock_id" VARCHAR(10) NOT NULL,
    "ex_date" DATE NOT NULL,
    "cash" DECIMAL(12,6) NOT NULL,
    "stock_div" DECIMAL(12,6) NOT NULL,
    "pay_date" DATE,
    "period" VARCHAR(30),

    CONSTRAINT "stock_dividend_pkey" PRIMARY KEY ("stock_id","ex_date")
);

-- CreateTable
CREATE TABLE "backfill_log" (
    "stock_id" VARCHAR(10) NOT NULL,
    "dataset" VARCHAR(30) NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "rows" INTEGER NOT NULL,

    CONSTRAINT "backfill_log_pkey" PRIMARY KEY ("stock_id","dataset")
);

-- CreateIndex
CREATE INDEX "stock_dividend_ex_date_idx" ON "stock_dividend"("ex_date");

-- CreateIndex
CREATE INDEX "backfill_log_dataset_synced_at_idx" ON "backfill_log"("dataset", "synced_at");

-- AddForeignKey
ALTER TABLE "stock_dividend" ADD CONSTRAINT "stock_dividend_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stock"("stock_id") ON DELETE CASCADE ON UPDATE CASCADE;
