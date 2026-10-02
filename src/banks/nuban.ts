/**
 * CBN NUBAN (Nigeria Uniform Bank Account Number) check digit for deposit
 * money banks: 10 digits = 9-digit serial + 1 check digit, where the check
 * digit is computed over the 3-digit CBN bank code followed by the serial
 * with the repeating weights 3,7,3.
 *
 *   check = (10 - (Σ digit_i * weight_i) mod 10) mod 10
 */
const WEIGHTS = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3];

export function nubanCheckDigit(cbnBankCode: string, serial9: string): number {
  if (!/^\d{3}$/.test(cbnBankCode)) throw new Error('CBN bank code must be 3 digits');
  if (!/^\d{9}$/.test(serial9)) throw new Error('NUBAN serial must be 9 digits');
  const digits = (cbnBankCode + serial9).split('').map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * WEIGHTS[i], 0);
  return (10 - (sum % 10)) % 10;
}

export function isValidNuban(cbnBankCode: string, accountNumber: string): boolean {
  if (!/^\d{10}$/.test(accountNumber)) return false;
  return nubanCheckDigit(cbnBankCode, accountNumber.slice(0, 9)) === Number(accountNumber[9]);
}

export function buildNuban(cbnBankCode: string, serial: number | bigint): string {
  const serial9 = serial.toString().padStart(9, '0');
  if (serial9.length !== 9) throw new Error('NUBAN serial overflow');
  return serial9 + nubanCheckDigit(cbnBankCode, serial9);
}
