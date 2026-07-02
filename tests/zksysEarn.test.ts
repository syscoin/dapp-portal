import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  ZKSYS_BPS_DENOMINATOR,
  ZKSYS_LONG_RUN_RATE_BPS,
  ZKSYS_YEAR_1_RATE_BPS,
  ZKSYS_YEAR_2_RATE_BPS,
  ZKSYS_YEAR_3_RATE_BPS,
  zkSysAnnualRateBps,
  zkSysCumulativeScheduledRewards,
  zkSysEffectivePeriodStartTime,
  zkSysFormatDuration,
  zkSysPeriodAt,
  zkSysPeriodCloseTime,
  zkSysPeriodEmission,
  zkSysProjectedPeriodRewards,
  zkSysUndistributedRewards,
} from "../utils/zksysEarn";

// Live Tanenbaum deployment parameters (SyscoinZKSYSToken / ZkSysIssuer).
const maxSupply = 210_000_000n * 10n ** 18n;
const periodsPerYear = 365n;
const periodSeconds = 86_400n;
const startTime = 1_782_775_442n; // 2026-06-29 23:24:02 UTC

describe("zkSYS issuance schedule (mirror of ZkSysIssuer.sol)", () => {
  it("matches the contract annual rate schedule", () => {
    assert.equal(zkSysAnnualRateBps(0n), ZKSYS_YEAR_1_RATE_BPS);
    assert.equal(zkSysAnnualRateBps(1n), ZKSYS_YEAR_2_RATE_BPS);
    assert.equal(zkSysAnnualRateBps(2n), ZKSYS_YEAR_3_RATE_BPS);
    assert.equal(zkSysAnnualRateBps(3n), ZKSYS_LONG_RUN_RATE_BPS);
    assert.equal(zkSysAnnualRateBps(100n), ZKSYS_LONG_RUN_RATE_BPS);
  });

  it("returns zero before any period has elapsed", () => {
    assert.equal(zkSysCumulativeScheduledRewards(0n, maxSupply, periodsPerYear), 0n);
  });

  it("schedules 20% of the cap across the first year, pro-rated per period", () => {
    const yearOne = zkSysCumulativeScheduledRewards(periodsPerYear, maxSupply, periodsPerYear);
    assert.equal(yearOne, (maxSupply * ZKSYS_YEAR_1_RATE_BPS) / ZKSYS_BPS_DENOMINATOR);

    // A single period is exactly 1/365 of the annual emission (floored).
    const annualEmission = (maxSupply * ZKSYS_YEAR_1_RATE_BPS) / ZKSYS_BPS_DENOMINATOR;
    assert.equal(zkSysCumulativeScheduledRewards(1n, maxSupply, periodsPerYear), annualEmission / periodsPerYear);
  });

  it("compounds year 2 and 3 rates against the remaining supply", () => {
    const yearOne = (maxSupply * ZKSYS_YEAR_1_RATE_BPS) / ZKSYS_BPS_DENOMINATOR;
    const yearTwo = yearOne + ((maxSupply - yearOne) * ZKSYS_YEAR_2_RATE_BPS) / ZKSYS_BPS_DENOMINATOR;
    const yearThree = yearTwo + ((maxSupply - yearTwo) * ZKSYS_YEAR_3_RATE_BPS) / ZKSYS_BPS_DENOMINATOR;

    assert.equal(zkSysCumulativeScheduledRewards(periodsPerYear * 2n, maxSupply, periodsPerYear), yearTwo);
    assert.equal(zkSysCumulativeScheduledRewards(periodsPerYear * 3n, maxSupply, periodsPerYear), yearThree);
  });

  it("never exceeds the 210M supply cap even after centuries", () => {
    const farFuture = zkSysCumulativeScheduledRewards(periodsPerYear * 500n, maxSupply, periodsPerYear);
    assert.ok(farFuture < maxSupply);
    // Long-run 5% decay should still get very close to the cap.
    assert.ok(farFuture > (maxSupply * 99n) / 100n);
  });

  it("is monotonically non-decreasing period over period", () => {
    let previous = 0n;
    for (const periods of [1n, 10n, 100n, 365n, 366n, 730n, 1095n, 5000n]) {
      const scheduled = zkSysCumulativeScheduledRewards(periods, maxSupply, periodsPerYear);
      assert.ok(scheduled >= previous, `not monotonic at ${periods}`);
      previous = scheduled;
    }
  });

  it("computes per-period emission as the schedule delta", () => {
    const p0 = zkSysPeriodEmission(0n, maxSupply, periodsPerYear);
    const annualEmission = (maxSupply * ZKSYS_YEAR_1_RATE_BPS) / ZKSYS_BPS_DENOMINATOR;
    assert.equal(p0, annualEmission / periodsPerYear);

    // First period of year 2 emits at the year-2 rate on remaining supply.
    const yearOne = annualEmission;
    const yearTwoAnnual = ((maxSupply - yearOne) * ZKSYS_YEAR_2_RATE_BPS) / ZKSYS_BPS_DENOMINATOR;
    assert.equal(zkSysPeriodEmission(periodsPerYear, maxSupply, periodsPerYear), yearTwoAnnual / periodsPerYear);
  });
});

describe("zkSYS period math", () => {
  it("mirrors ZkSysIssuer.currentPeriod", () => {
    assert.equal(zkSysPeriodAt(startTime - 1n, startTime, periodSeconds), 0n);
    assert.equal(zkSysPeriodAt(startTime, startTime, periodSeconds), 0n);
    assert.equal(zkSysPeriodAt(startTime + periodSeconds - 1n, startTime, periodSeconds), 0n);
    assert.equal(zkSysPeriodAt(startTime + periodSeconds, startTime, periodSeconds), 1n);
    assert.equal(zkSysPeriodAt(startTime + 10n * periodSeconds + 5n, startTime, periodSeconds), 10n);
  });

  it("computes period close and effective-period start times", () => {
    assert.equal(zkSysPeriodCloseTime(0n, startTime, periodSeconds), startTime + periodSeconds);
    assert.equal(zkSysEffectivePeriodStartTime(3n, startTime, periodSeconds), startTime + 3n * periodSeconds);
  });
});

describe("zkSYS reward projections", () => {
  it("estimates undistributed rewards from the schedule gap", () => {
    const scheduled = zkSysCumulativeScheduledRewards(5n, maxSupply, periodsPerYear);
    assert.equal(
      zkSysUndistributedRewards({
        currentPeriod: 5n,
        totalScheduledRewards: 0n,
        maxSupply,
        periodsPerYear,
      }),
      scheduled
    );
    assert.equal(
      zkSysUndistributedRewards({
        currentPeriod: 5n,
        totalScheduledRewards: scheduled,
        maxSupply,
        periodsPerYear,
      }),
      0n
    );
  });

  it("splits period emission by weight share", () => {
    assert.equal(zkSysProjectedPeriodRewards(0n, 100n, 1000n), 0n);
    assert.equal(zkSysProjectedPeriodRewards(50n, 0n, 1000n), 0n);
    assert.equal(zkSysProjectedPeriodRewards(50n, 100n, 1000n), 500n);
    assert.equal(zkSysProjectedPeriodRewards(1n, 3n, 1000n), 333n);
  });
});

describe("zkSYS duration formatting", () => {
  it("formats durations at day/hour/minute granularity", () => {
    assert.equal(zkSysFormatDuration(-5), "0m");
    assert.equal(zkSysFormatDuration(30), "<1m");
    assert.equal(zkSysFormatDuration(120), "2m");
    assert.equal(zkSysFormatDuration(3_600), "1h");
    assert.equal(zkSysFormatDuration(3_660), "1h 1m");
    assert.equal(zkSysFormatDuration(90_000), "1d 1h");
    assert.equal(zkSysFormatDuration(172_800), "2d");
  });
});
