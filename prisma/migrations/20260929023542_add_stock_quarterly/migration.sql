-- CreateTable
CREATE TABLE "stock_quarterly" (
    "stock_id" VARCHAR(10) NOT NULL,
    "period_end" DATE NOT NULL,
    "revenue" BIGINT,
    "gross_profit" BIGINT,
    "operating_income" BIGINT,
    "pretax_income" BIGINT,
    "net_income" BIGINT,
    "net_income_parent" BIGINT,
    "eps" DECIMAL(10,2),
    "total_assets" BIGINT,
    "total_liabilities" BIGINT,
    "total_equity" BIGINT,
    "equity_parent" BIGINT,
    "book_value_per_share" DECIMAL(12,2),

    CONSTRAINT "stock_quarterly_pkey" PRIMARY KEY ("stock_id","period_end")
);

-- CreateIndex
CREATE INDEX "stock_quarterly_period_end_idx" ON "stock_quarterly"("period_end");

-- AddForeignKey
ALTER TABLE "stock_quarterly" ADD CONSTRAINT "stock_quarterly_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stock"("stock_id") ON DELETE CASCADE ON UPDATE CASCADE;
