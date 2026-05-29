import type { Env } from '../types/env';
import { sendViaOutlook } from '../integrations/outlook-send';

function buildVerificationHtml(fullName: string, verifyUrl: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 16px; color: #1a1a1a;">
  <div style="text-align: center; margin-bottom: 24px;">
    <h2 style="margin: 0; font-size: 22px;">Medina Intelligence</h2>
  </div>
  <p>Hi ${fullName},</p>
  <p>Welcome to Medina Intelligence. Please verify your email address to activate your account.</p>
  <div style="text-align: center; margin: 32px 0;">
    <a href="${verifyUrl}"
       style="display: inline-block; padding: 12px 32px; background: linear-gradient(135deg, #7c3aed, #6d28d9); color: white; text-decoration: none; border-radius: 8px; font-weight: 500;">
      Verify Email Address
    </a>
  </div>
  <p style="font-size: 13px; color: #666;">
    Or copy and paste this link into your browser:<br>
    <a href="${verifyUrl}" style="color: #7c3aed; word-break: break-all;">${verifyUrl}</a>
  </p>
  <p style="font-size: 13px; color: #666;">This link expires in 24 hours.</p>
  <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">
  <p style="font-size: 12px; color: #999;">If you didn't create an account, you can safely ignore this email.</p>
</body>
</html>`.trim();
}

export async function sendVerificationEmail(
  userId: string,
  email: string,
  fullName: string,
  verificationToken: string,
  orgId: string,
  env: Env
): Promise<{ ok: boolean; error?: string }> {
  try {
    const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
    const verifyUrl = `${frontendUrl}/auth/verify?token=${encodeURIComponent(verificationToken)}`;
    const html = buildVerificationHtml(fullName, verifyUrl);

    const result = await sendViaOutlook(
      {
        senderUserId: 'system',
        orgId,
        subject: 'Verify your Medina Intelligence account',
        body: html,
        toEmail: email,
      },
      env
    );

    if (!result.ok) {
      console.error(`[verification-email] Graph API sendMail failed: ${result.status} ${result.errorMessage}`);
      return { ok: false, error: result.errorMessage || `Send failed: ${result.status}` };
    }

    console.log(`[verification-email] Sent to ${email} successfully`);
    return { ok: true };
  } catch (e) {
    console.error(`[verification-email] Unexpected error:`, e);
    return { ok: false, error: `Unexpected error: ${(e as Error).message}` };
  }
}
