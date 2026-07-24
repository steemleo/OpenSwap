import { describe, expect, it } from "vitest";
import {
  formatAmountForDisplay,
  formatUsd,
  fromBaseUnits,
  parseDecimalInput,
  parseJsonPreservingBigInts,
  toBaseUnits
} from "../../src/core/amount.js";

describe("parseDecimalInput", () => {
  it("normalizes valid input", () => {
    expect(parseDecimalInput("500")).toBe("500");
    expect(parseDecimalInput(" 1000.50 ")).toBe("1000.5");
    expect(parseDecimalInput(".5")).toBe("0.5");
    expect(parseDecimalInput("007.100")).toBe("7.1");
  });
  it("rejects invalid input", () => {
    expect(() => parseDecimalInput("abc")).toThrow();
    expect(() => parseDecimalInput("-5")).toThrow();
    expect(() => parseDecimalInput("1e18")).toThrow();
    expect(() => parseDecimalInput("0")).toThrow();
    expect(() => parseDecimalInput("0.000")).toThrow();
  });
  // "1,5" is 1.5 across most of Europe. Stripping the comma made it 15.
  it("rejects commas rather than guessing which convention was meant", () => {
    expect(() => parseDecimalInput("1,5")).toThrow(/ambiguous/);
    expect(() => parseDecimalInput("1,00")).toThrow(/ambiguous/);
    expect(() => parseDecimalInput("1,000.50")).toThrow(/ambiguous/);
    expect(() => parseDecimalInput("1,000")).toThrow(/ambiguous/);
  });
});

describe("toBaseUnits / fromBaseUnits", () => {
  it("round-trips exactly", () => {
    expect(toBaseUnits("500", 6)).toBe(500000000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
    expect(fromBaseUnits(500000000n, 6)).toBe("500");
    expect(fromBaseUnits("54578044804470400", 18)).toBe("0.0545780448044704");
  });
  it("is exact where floats are not (NEAR 24 decimals)", () => {
    expect(toBaseUnits("1.000000000000000000000001", 24)).toBe(1000000000000000000000001n);
    expect(fromBaseUnits("1000000000000000000000001", 24)).toBe("1.000000000000000000000001");
  });
  it("rejects excess precision", () => {
    expect(() => toBaseUnits("0.0000001", 6)).toThrow();
  });
  it("handles zero-decimal assets", () => {
    expect(toBaseUnits("42", 0)).toBe(42n);
    expect(fromBaseUnits(42n, 0)).toBe("42");
  });
  it("refuses exponent-form strings instead of silently truncating them", () => {
    // Regression: "2.3888788784293103e+25" used to split on "." and become 2n,
    // rendering ~23.9M SHIB as 0.000000000000000002.
    expect(() => fromBaseUnits("2.3888788784293103e+25", 18)).toThrow();
    expect(() => fromBaseUnits("1e+21", 18)).toThrow();
    // a plain integer string of the same magnitude is still fine
    expect(fromBaseUnits("23888788784293103000000000", 18)).toBe("23888788.784293103");
  });
});

describe("parseJsonPreservingBigInts", () => {
  it("preserves unsafe integers as strings", () => {
    const parsed = parseJsonPreservingBigInts(
      '{"data":{"expected_amount_out":54578044804470401,"ttl_seconds":30}}',
      ["expected_amount_out"]
    ) as { data: { expected_amount_out: string; ttl_seconds: number } };
    expect(parsed.data.expected_amount_out).toBe("54578044804470401");
    expect(parsed.data.ttl_seconds).toBe(30);
  });
  it("leaves small numbers as numbers", () => {
    const parsed = parseJsonPreservingBigInts('{"expected_amount_out":500000000}', [
      "expected_amount_out"
    ]) as { expected_amount_out: number };
    expect(parsed.expected_amount_out).toBe(500000000);
  });
  it("does not touch unrelated fields", () => {
    const parsed = parseJsonPreservingBigInts('{"expires_at":1784303525217}', [
      "expected_amount_out"
    ]) as { expires_at: number };
    expect(parsed.expires_at).toBe(1784303525217);
  });

  // JSON.stringify switches to exponent notation at |n| >= 1e21, so any payout
  // of >= 1000 units of an 18-decimal asset arrives in a form the plain-integer
  // pattern cannot see. Production serves these today (SHIB, LINK, UNI...).
  it("expands exponent-form base units exactly", () => {
    const cases: Array<[string, string]> = [
      ["1e+21", "1000000000000000000000"],
      ["2.390638634897e+25", "23906386348970000000000000"],
      ["5.968752636792878e+21", "5968752636792878000000"],
      ["1.2345e+21", "1234500000000000000000"],
      ["2.3888788784293103e+25", "23888788784293103000000000"]
    ];
    for (const [literal, expected] of cases) {
      const parsed = parseJsonPreservingBigInts(`{"expected_amount_out":${literal}}`, [
        "expected_amount_out"
      ]) as { expected_amount_out: string };
      expect(parsed.expected_amount_out, `literal ${literal}`).toBe(expected);
      // the whole point: the result must survive BigInt and the display path
      expect(() => BigInt(parsed.expected_amount_out)).not.toThrow();
    }
  });

  it("keeps just-below-threshold plain integers on the existing path", () => {
    const parsed = parseJsonPreservingBigInts('{"expected_amount_out":597696122022575500000}', [
      "expected_amount_out"
    ]) as { expected_amount_out: string };
    expect(parsed.expected_amount_out).toBe("597696122022575500000");
  });

  it("handles exponent form in nested and multi-field payloads", () => {
    const parsed = parseJsonPreservingBigInts(
      '{"quotes":[{"data":{"expected_amount_out":2.39e+25,"ttl_seconds":30}},{"data":{"expected_amount_out":123456,"ttl_seconds":30}}]}',
      ["expected_amount_out"]
    ) as { quotes: Array<{ data: { expected_amount_out: string | number; ttl_seconds: number } }> };
    expect(parsed.quotes[0]!.data.expected_amount_out).toBe("23900000000000000000000000");
    expect(parsed.quotes[0]!.data.ttl_seconds).toBe(30);
    expect(parsed.quotes[1]!.data.expected_amount_out).toBe(123456);
  });

  it("leaves a non-integral exponent value alone rather than fabricating one", () => {
    // 1.5e+2 is 150 but sub-threshold; a negative exponent is not a base unit at
    // all. Neither should be rewritten into something that looks authoritative.
    const parsed = parseJsonPreservingBigInts('{"expected_amount_out":1.5e-7}', [
      "expected_amount_out"
    ]) as { expected_amount_out: number };
    expect(typeof parsed.expected_amount_out).toBe("number");
  });
});

describe("formatAmountForDisplay", () => {
  it("adds thousands separators and trims fraction", () => {
    expect(formatAmountForDisplay("1000")).toBe("1,000");
    expect(formatAmountForDisplay("0.0545780448044704")).toBe("0.054578044");
    expect(formatAmountForDisplay("0.00000000123456789")).toBe("0.0000000012345678");
  });
});

describe("formatUsd", () => {
  it("formats and preserves nulls", () => {
    expect(formatUsd(986.2)).toBe("$986.20");
    expect(formatUsd(0.002885)).toBe("$0.0029");
    expect(formatUsd(null)).toBeNull();
    expect(formatUsd(Number.NaN)).toBeNull();
  });
});
