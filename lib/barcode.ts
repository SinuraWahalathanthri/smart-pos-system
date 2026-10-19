/** EAN-13 helpers. Shop-generated labels use an in-store prefix so they never clash with real products. */

export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error("EAN-13 needs exactly 12 digits");
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(first12[i]);
    sum += i % 2 === 0 ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** Build a valid EAN-13 from a prefix and a running number (prefix 200-299 is reserved for in-store use). */
export function makeEan13(prefix: string, serial: number): string {
  const body = (prefix + String(serial).padStart(12 - prefix.length, "0")).slice(0, 12);
  return body + ean13CheckDigit(body);
}
