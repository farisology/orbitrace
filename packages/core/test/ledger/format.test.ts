// Ticket #26: the one rounding of a ledger cost, for display.
import { describe, expect, it } from "vitest";
import { formatCostEstimate } from "../../src/index.js";

describe("formatCostEstimate", () => {
  it("rounds picodollars once, half up, to whole cents", () => {
    expect(formatCostEstimate(0n)).toBe("$0.00");
    expect(formatCostEstimate(5_000_000_000n)).toBe("$0.01");
    expect(formatCostEstimate(14_999_999_999n)).toBe("$0.01");
    expect(formatCostEstimate(15_000_000_000n)).toBe("$0.02");
    expect(formatCostEstimate(420_000_000_000n)).toBe("$0.42");
    expect(formatCostEstimate(1_000_000_000_000n)).toBe("$1.00");
    expect(formatCostEstimate(1_234_505_000_000_000n)).toBe("$1,234.51");
    expect(formatCostEstimate(150_000_000_000_000_000n)).toBe("$150,000.00");
  });

  it("never shows a cost above zero as free", () => {
    expect(formatCostEstimate(1n)).toBe("< $0.01");
    expect(formatCostEstimate(4_999_999_999n)).toBe("< $0.01");
  });

  it("shows a negative value as zero", () => {
    expect(formatCostEstimate(-1n)).toBe("$0.00");
  });
});
