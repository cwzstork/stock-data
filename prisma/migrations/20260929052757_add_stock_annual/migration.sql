-- CreateTable
CREATE TABLE "stock_annual" (
    "stock_id" VARCHAR(10) NOT NULL,
    "year" INTEGER NOT NULL,
    "avg_close" DECIMAL(14,4),
    "high" DECIMAL(14,4),
    "low" DECIMAL(14,4),
    "last_close" DECIMAL(14,4),
    "days" INTEGER NOT NULL,
    "avg_per" DECIMAL(10,2),
    "min_per" DECIMAL(10,2),
    "avg_pbr" DECIMAL(10,2),
    "min_pbr" DECIMAL(10,2),
    "avg_yield" DECIMAL(8,4),
    "max_yield" DECIMAL(8,4),

    CONSTRAINT "stock_annual_pkey" PRIMARY KEY ("stock_id","year")
);

-- CreateIndex
CREATE INDEX "stock_annual_year_idx" ON "stock_annual"("year");

-- AddForeignKey
ALTER TABLE "stock_annual" ADD CONSTRAINT "stock_annual_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stock"("stock_id") ON DELETE CASCADE ON UPDATE CASCADE;
