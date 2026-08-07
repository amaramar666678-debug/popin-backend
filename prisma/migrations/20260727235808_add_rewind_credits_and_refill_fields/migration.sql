-- AlterTable
ALTER TABLE "User" ADD COLUMN     "eye_refill_at" TIMESTAMP(3),
ADD COLUMN     "rewind_credits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rewind_refill_at" TIMESTAMP(3),
ALTER COLUMN "hearts" SET DEFAULT 30,
ALTER COLUMN "message_credits" SET DEFAULT 2;
