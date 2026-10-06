/** Parse a user-entered decimal string into integer cents. Returns NaN if invalid. */
export function toCents(input: string): number {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d*(\.\d{0,2})?$/.test(s) || s === "" || s === ".") return NaN;
  return Math.round(parseFloat(s) * 100);
}

export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

export const CURRENCIES = ["USD", "EUR", "GBP", "INR", "CAD", "AUD", "SGD", "AED", "CHF", "CNY", "MXN", "BRL", "ZAR"];

/** Today's date as YYYY-MM-DD in the user's local timezone. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
