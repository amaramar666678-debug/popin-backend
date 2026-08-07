-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "disappearing_messages" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "chat_color_changed_at" TIMESTAMP(3);
