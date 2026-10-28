-- 宏觀事件預覽：一天一份報告的快照。內容是 JSONB，結構見 src/lib/macro.ts 的 MacroPayload。
-- CreateTable
CREATE TABLE "macro_report" (
    "report_date" DATE NOT NULL,
    "generated_at" TIMESTAMPTZ(3) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "macro_report_pkey" PRIMARY KEY ("report_date")
);
