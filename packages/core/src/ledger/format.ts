/**
 * Ticket #26. Display of a ledger cost. The ledger keeps exact picodollars; this is the one
 * place they are rounded.
 */

/** Picodollars in one US cent. */
const PICO_PER_CENT = 10_000_000_000n;

/** Groups of three digits with commas, the same in every locale: `1,234`. */
function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A cost in picodollars as US dollars (USD; the `$` is always US dollars), rounded once, half up, to whole cents: `$0.00`,
 * `$0.42`, `$1,234.50`. A cost above zero that rounds to `$0.00` reads `< $0.01`, so a small
 * cost never reads as free. A negative cost (not produced by the ledger) reads as `$0.00`.
 */
export function formatCostEstimate(picoUsd: bigint): string {
  if (picoUsd <= 0n) return "$0.00";
  const cents = (picoUsd + PICO_PER_CENT / 2n) / PICO_PER_CENT;
  if (cents === 0n) return "< $0.01";
  const dollars = cents / 100n;
  const rest = String(cents % 100n).padStart(2, "0");
  return `$${groupDigits(String(dollars))}.${rest}`;
}

/** A price in micro-dollars per million tokens as dollars, without trailing zeros: `$0.125`. */
export function formatPricePerMillion(microUsd: number): string {
  const whole = Math.floor(microUsd / 1_000_000);
  const fraction = String(microUsd % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  const decimals = fraction.length === 1 ? `${fraction}0` : fraction;
  return decimals === "" ? `$${whole}` : `$${whole}.${decimals}`;
}
