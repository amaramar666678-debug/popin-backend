const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const { EMAIL_USER, EMAIL_PASS } = process.env;
  if (!EMAIL_USER || !EMAIL_PASS) {
    throw new Error("EMAIL_USER / EMAIL_PASS are not configured in .env");
  }

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS, // Gmail app password (16 chars, spaces stripped by Gmail)
    },
  });

  return transporter;
}

/**
 * Sends a verification email via Gmail SMTP.
 * Throws on failure so callers can log / respond via safeHttpError.
 *
 * @param {string} recipientEmail
 * @param {string} verificationCode 6-digit code
 */
async function sendVerificationEmailGmail(recipientEmail, verificationCode) {
  const mailOptions = {
    from: `"Popin App" <${process.env.EMAIL_USER}>`,
    to: recipientEmail,
    subject: "رمز التحقق الخاص بك في تطبيق Popin",
    html: `
      <div dir="rtl" style="font-family: Tahoma, sans-serif; padding: 20px; color: #333; background-color: #f9f9f9; border-radius: 8px;">
        <h2 style="color: #2c3e50;">مرحباً بك في تطبيق Popin</h2>
        <p>لتأكيد حسابك، يرجى استخدام رمز التحقق التالي:</p>
        <div style="background: #e8f4f8; padding: 12px 24px; font-size: 26px; font-weight: bold; color: #3498db; display: inline-block; border-radius: 6px; letter-spacing: 2px;">
          ${verificationCode}
        </div>
        <p style="margin-top: 20px; color: #666; font-size: 14px;">إذا لم تقم بطلب هذا الرمز، يمكنك تجاهل هذه الرسالة.</p>
      </div>
    `,
  };

  await getTransporter().sendMail(mailOptions);
  console.log("[gmail] Verification email sent to:", recipientEmail);
}

module.exports = { sendVerificationEmailGmail, sendDeletionCodeEmail };

/**
 * Sends a 6-digit code used to confirm a permanent account deletion
 * (web-based deletion flow).
 * Throws on failure so callers can log / respond via safeHttpError.
 *
 * @param {string} recipientEmail
 * @param {string} verificationCode 6-digit code
 */
async function sendDeletionCodeEmail(recipientEmail, verificationCode) {
  const mailOptions = {
    from: `"Popin App" <${process.env.EMAIL_USER}>`,
    to: recipientEmail,
    subject: "تأكيد حذف الحساب في تطبيق Popin",
    html: `
      <div dir="rtl" style="font-family: Tahoma, sans-serif; padding: 20px; color: #333; background-color: #f9f9f9; border-radius: 8px;">
        <h2 style="color: #c0392b;">طلب حذف الحساب</h2>
        <p>لقد تلقينا طلباً لحذف حسابك نهائياً. لتأكيد الحذف، يرجى استخدام رمز التأكيد التالي:</p>
        <div style="background: #fdecea; padding: 12px 24px; font-size: 26px; font-weight: bold; color: #c0392b; display: inline-block; border-radius: 6px; letter-spacing: 2px;">
          ${verificationCode}
        </div>
        <p style="margin-top: 20px; color: #666; font-size: 14px;">هذا الرمز صالح لمدة 10 دقائق. إذا لم تقم بطلب حذف حسابك، يمكنك تجاهل هذه الرسالة — لن يُحذف حسابك.</p>
      </div>
    `,
  };

  await getTransporter().sendMail(mailOptions);
  console.log("[gmail] Deletion code email sent to:", recipientEmail);
}
