const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
export const ERROR_ID_PATTERN = /^[0-9A-F][0-9A-HJKMNP-TV-Z]{12}$/

/** Keep all 64 random bits in a fixed-width Crockford Base32 receipt. */
export function newErrorId(): string {
  const words = crypto.getRandomValues(new Uint32Array(2))
  let value = (BigInt(words[0]!) << 32n) | BigInt(words[1]!)
  let id = ""
  for (let i = 0; i < 13; i++) {
    id = ALPHABET[Number(value & 31n)]! + id
    value >>= 5n
  }
  return id
}

export function formatErrorId(id: string): string {
  return ERROR_ID_PATTERN.test(id) ? `${id.slice(0, 4)}-${id.slice(4, 8)}-${id.slice(8)}` : id
}
