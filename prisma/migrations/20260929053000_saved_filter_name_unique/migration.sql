-- saved_filter.name 改為唯一：存同名條件就是覆蓋。
-- 手寫這支是因為 prisma migrate dev 對「新增唯一約束」要互動確認
-- （怕既有資料有重複），而 CI 與這裡都是非互動環境。
-- 建立時該表是空的，沒有重複風險。
CREATE UNIQUE INDEX "saved_filter_name_key" ON "saved_filter"("name");
