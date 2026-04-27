// RFC 6238 TOTP via WebCrypto. Compatible with Microsoft Authenticator,
// Google Authenticator, 1Password, etc.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function generateSecret(byteLength = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base32Encode(bytes);
}

export function otpauthUrl(secret: string, accountEmail: string, issuer = 'Medina'): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

async function hotp(keyBytes: Uint8Array, counter: number): Promise<string> {
  // 8-byte big-endian counter
  const counterBytes = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes));
  const offset = sig[sig.length - 1] & 0x0f;
  const code =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  return (code % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

export async function verifyTotp(secret: string, code: string, window = 1, nowMs = Date.now()): Promise<boolean> {
  const cleaned = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const key = base32Decode(secret);
  const step = Math.floor(nowMs / 1000 / STEP_SECONDS);
  for (let w = -window; w <= window; w++) {
    const expected = await hotp(key, step + w);
    // Constant-time compare
    if (expected.length === cleaned.length) {
      let diff = 0;
      for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ cleaned.charCodeAt(i);
      if (diff === 0) return true;
    }
  }
  return false;
}

export function generateRecoveryCodes(n = 10): { plain: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    codes.push(`${hex.slice(0, 5)}-${hex.slice(5, 10)}`);
  }
  return { plain: codes };
}

export async function hashRecoveryCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code.toLowerCase().trim()));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
