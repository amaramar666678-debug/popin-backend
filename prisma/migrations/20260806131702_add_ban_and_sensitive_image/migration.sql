-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "isSensitive" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "ban_expires_at" TIMESTAMP(3),
ADD COLUMN     "ban_reason" TEXT,
ADD COLUMN     "is_banned" BOOLEAN NOT NULL DEFAULT false;
