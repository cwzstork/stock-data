-- CreateTable
CREATE TABLE "stock_capital" (
    "stock_id" VARCHAR(10) NOT NULL,
    "report_date" DATE NOT NULL,
    "capital" BIGINT NOT NULL,

    CONSTRAINT "stock_capital_pkey" PRIMARY KEY ("stock_id","report_date")
);

-- CreateIndex
CREATE INDEX "stock_capital_report_date_idx" ON "stock_capital"("report_date");

-- AddForeignKey
ALTER TABLE "stock_capital" ADD CONSTRAINT "stock_capital_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stock"("stock_id") ON DELETE CASCADE ON UPDATE CASCADE;
