-- AlterTable
ALTER TABLE "stock_capital" ADD COLUMN     "issued_shares" BIGINT;

-- AlterTable
ALTER TABLE "stock_quarterly" ADD COLUMN     "current_assets" BIGINT,
ADD COLUMN     "current_liabilities" BIGINT;

-- CreateTable
CREATE TABLE "stock_insider" (
    "stock_id" VARCHAR(10) NOT NULL,
    "period_end" DATE NOT NULL,
    "director_shares" BIGINT,
    "director_pledged" BIGINT,
    "manager_shares" BIGINT,
    "major_shares" BIGINT,

    CONSTRAINT "stock_insider_pkey" PRIMARY KEY ("stock_id","period_end")
);

-- CreateIndex
CREATE INDEX "stock_insider_period_end_idx" ON "stock_insider"("period_end");

-- AddForeignKey
ALTER TABLE "stock_insider" ADD CONSTRAINT "stock_insider_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stock"("stock_id") ON DELETE CASCADE ON UPDATE CASCADE;
