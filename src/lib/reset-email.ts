import type { Env } from '../types/env';
import { sendViaOutlook } from '../integrations/outlook-send';

function buildResetHtml(fullName: string, resetUrl: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 16px; color: #1a1a2e;">
  <div style="text-align: center; margin-bottom: 32px;">
    <h1 style="font-size: 24px; font-weight: 700; margin: 0; color: #1a1a2e;">Medina Intelligence</h1>
  </div>
  <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 16px;">Reset your password</h2>
  <p style="font-size: 15px; line-height: 1.6; color: #444;">Hi ${fullName},</p>
  <p style="font-size: 15px; line-height: 1.6; color: #444;">We received a request to reset your password. Click the button below to choose a new one.</p>
  <div style="text-align: center; margin: 32px 0;">
    <a href="${resetUrl}"
       style="display: inline-block; padding: 14px 40px; background: linear-gradient(135deg, #7c3aed, #a855f7); color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">
      Reset Password
    </a>
  </div>
  <p style="font-size: 13px; line-height: 1.6; color: #888;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't be changed.</p>
  <p style="font-size: 13px; line-height: 1.6; color: #888;">If the button doesn't work, copy and paste this URL into your browser:</p>
  <p style="font-size: 12px; word-break: break-all; color: #aaa;">${resetUrl}</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
  <p style="font-size: 12px; color: #aaa; text-align: center;">Medina Intelligence Platform</p>
</body>
</html>`.trim();
}

export async function sendResetEmail(
  toEmail: string,
  fullName: string,
  resetUrl: string,
  orgId: string,
  env: Env
): Promise<{ ok: boolean; error?: string }> {
  try {
    const html = buildResetHtml(fullName, resetUrl);
    const result = await sendViaOutlook(
      {
        senderUserId: 'system',
        orgId,
        subject: 'Reset your Medina Intelligence password',
        body: html,
        toEmail,
      },
      env
    );

    if (!result.ok) {
      console.error(`[reset-email] sendMail failed: ${result.status} ${result.errorMessage}`);
      return { ok: false, error: result.errorMessage || `Send failed: ${result.status}` };
    }

    console.log(`[reset-email] Sent to ${toEmail} successfully`);
    return { ok: true };
  } catch (e) {
    console.error(`[reset-email] Unexpected error:`, e);
    return { ok: false, error: `Unexpected error: ${(e as Error).message}` };
  }
}
