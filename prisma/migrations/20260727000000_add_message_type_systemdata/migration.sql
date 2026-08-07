-- AlterTable
ALTER TABLE "Message" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'text',
ADD COLUMN "systemData" JSONB;
