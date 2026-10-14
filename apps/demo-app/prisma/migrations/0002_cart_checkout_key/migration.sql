-- AlterTable
ALTER TABLE "carts" ADD COLUMN     "checkout_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "carts_checkout_key_key" ON "carts"("checkout_key");
