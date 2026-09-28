-- CreateTable
CREATE TABLE "stock" (
    "stock_id" VARCHAR(10) NOT NULL,
    "stock_name" VARCHAR(60) NOT NULL,
    "market" VARCHAR(10) NOT NULL,
    "industry_category" VARCHAR(60),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_pkey" PRIMARY KEY ("stock_id")
);

-- CreateTable
CREATE TABLE "stock_daily" (
    "stock_id" VARCHAR(10) NOT NULL,
    "trade_date" DATE NOT NULL,
    "close" DECIMAL(12,4),
    "volume" BIGINT,
    "turnover" BIGINT,
    "dividend_yield" DECIMAL(8,4),
    "per" DECIMAL(10,2),
    "pbr" DECIMAL(10,2),

    CONSTRAINT "stock_daily_pkey" PRIMARY KEY ("stock_id","trade_date")
);

-- CreateIndex
CREATE INDEX "stock_market_idx" ON "stock"("market");

-- CreateIndex
CREATE INDEX "stock_industry_category_idx" ON "stock"("industry_category");

-- CreateIndex
CREATE INDEX "stock_daily_trade_date_idx" ON "stock_daily"("trade_date");

-- CreateIndex
CREATE INDEX "stock_daily_trade_date_dividend_yield_idx" ON "stock_daily"("trade_date", "dividend_yield");

-- AddForeignKey
ALTER TABLE "stock_daily" ADD CONSTRAINT "stock_daily_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stock"("stock_id") ON DELETE CASCADE ON UPDATE CASCADE;
