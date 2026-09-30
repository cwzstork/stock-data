-- CreateTable
CREATE TABLE "stock_revenue" (
    "stock_id" VARCHAR(10) NOT NULL,
    "month" DATE NOT NULL,
    "revenue" BIGINT NOT NULL,

    CONSTRAINT "stock_revenue_pkey" PRIMARY KEY ("stock_id","month")
);

-- CreateIndex
CREATE INDEX "stock_revenue_month_idx" ON "stock_revenue"("month");

-- AddForeignKey
ALTER TABLE "stock_revenue" ADD CONSTRAINT "stock_revenue_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stock"("stock_id") ON DELETE CASCADE ON UPDATE CASCADE;
