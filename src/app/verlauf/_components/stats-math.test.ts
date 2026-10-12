import { describe, expect, it } from "vitest";
import { betterOf, tailMs, wilsonPct } from "./stats-math";

describe("wilsonPct", () => {
  it("returns null without samples", () => {
    expect(wilsonPct(0, 0)).toBeNull();
  });
  it("gives a non-zero upper bound for 0 losses", () => {
    const w = wilsonPct(0, 100);
    expect(w?.lo).toBe(0);
    expect(w?.hi).toBeCloseTo(3.7, 1);
  });
  it("brackets the observed share", () => {
    const w = wilsonPct(10, 1000);
    expect(w).not.toBeNull();
    expect(w!.lo).toBeLessThan(1);
    expect(w!.hi).toBeGreaterThan(1);
    expect(w!.lo).toBeCloseTo(0.54, 1);
    expect(w!.hi).toBeCloseTo(1.83, 1);
  });
});

describe("tailMs", () => {
  it("computes p99 - p50", () => {
    expect(tailMs({ p50: 20, p99: 180 })).toBe(160);
    expect(tailMs({ p50: null, p99: 180 })).toBeNull();
  });
});

describe("betterOf", () => {
  it("prefers the smaller value", () => {
    expect(betterOf(10, 20)).toBe("a");
    expect(betterOf(20, 10)).toBe("b");
  });
  it("treats near-equal values as a tie", () => {
    expect(betterOf(10, 10.2)).toBeNull();
    expect(betterOf(0, 0.01)).toBeNull();
    expect(betterOf(null, 3)).toBeNull();
  });
});
