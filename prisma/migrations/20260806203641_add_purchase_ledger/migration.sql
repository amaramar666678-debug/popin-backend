-- AlterTable
ALTER TABLE "User" ADD COLUMN     "is_premium" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subscription_expires_at" TIMESTAMP(3),
ADD COLUMN     "subscription_tier" TEXT;

-- CreateTable
CREATE TABLE "PurchaseLedger" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "purchaseToken" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'product',
    "amount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseLedger_purchaseToken_key" ON "PurchaseLedger"("purchaseToken");

-- CreateIndex
CREATE INDEX "PurchaseLedger_userId_idx" ON "PurchaseLedger"("userId");

-- CreateIndex
CREATE INDEX "PurchaseLedger_createdAt_idx" ON "PurchaseLedger"("createdAt");

-- AddForeignKey
ALTER TABLE "PurchaseLedger" ADD CONSTRAINT "PurchaseLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
