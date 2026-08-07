-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "initiated_by_user_id" INTEGER,
ADD COLUMN     "is_direct_message" BOOLEAN NOT NULL DEFAULT false;
