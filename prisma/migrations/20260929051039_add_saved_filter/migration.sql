-- CreateTable
CREATE TABLE "saved_filter" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "query" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_filter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_filter_created_at_idx" ON "saved_filter"("created_at");
