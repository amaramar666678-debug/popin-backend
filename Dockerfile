# استخدام صورة Node الرسمية
FROM node:20-alpine

# تحديد مجلد العمل داخل الحاوية
WORKDIR /app

# نسخ ملفات حزم العقد (package.json و package-lock.json) أولاً لتحسين الكاش
COPY package*.json ./

# تثبيت الحزم
RUN npm install

# نسخ باقي ملفات المشروع (بما في ذلك مجلد prisma والمجلدات البرمجية)
COPY . .

# توليد Prisma Client
RUN npx prisma generate

# التأكد من صلاحيات التنفيذ لملف entrypoint.sh (يحمي من مشاكل Line endings عند اللصق من Windows)
RUN sed -i 's/\r$//' entrypoint.sh && chmod +x entrypoint.sh

# تعريض المنفذ الذي يعمل عليه التطبيق
EXPOSE 3000

# تنفيذ الترحيل (Migrations) أولاً لإنشاء الجداول، ثم تشغيل السيرفر
ENTRYPOINT ["./entrypoint.sh"]