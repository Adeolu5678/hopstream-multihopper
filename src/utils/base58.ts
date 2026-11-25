const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map<string, number>(
  Array.from(ALPHABET).map((ch, idx) => [ch, idx])
);

/**
 * Decodes a base58-encoded string into raw bytes without external runtime CJS/ESM conflicts.
 */
export function decodeBase58(input: string): Uint8Array {
  if (input.length === 0) {
    return new Uint8Array(0);
  }

  const bytes: number[] = [0];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === undefined) continue;
    const val = ALPHABET_MAP.get(ch);
    if (val === undefined) {
      throw new Error(`Invalid base58 character '${ch}' at position ${i}`);
    }

    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      const current = bytes[j] ?? 0;
      carry += current * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === "1") {
    leadingZeros++;
  }

  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[out.length - 1 - i] = bytes[i] ?? 0;
  }
  return out;
}

/**
 * Encodes raw bytes into a canonical base58 string.
 */
export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }

  const digits: number[] = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j++) {
      const current = digits[j] ?? 0;
      carry += current << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros++;
  }

  let result = "1".repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    result += ALPHABET[digits[i] ?? 0] ?? "";
  }
  return result;
}
