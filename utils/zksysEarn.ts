// SYSCOIN: pure bigint helpers mirroring ZkSysIssuer.sol emission math from
// zksync-os-server/contracts/src/zksys/ZkSysIssuer.sol. Keep this file free of
// portal imports so it stays trivially unit-testable.

export const ZKSYS_BPS_DENOMINATOR = 10_000n;
export const ZKSYS_YEAR_1_RATE_BPS = 2_000n;
export const ZKSYS_YEAR_2_RATE_BPS = 1_200n;
export const ZKSYS_YEAR_3_RATE_BPS = 800n;
export const ZKSYS_LONG_RUN_RATE_BPS = 500n;

/** Mirror of ZkSysIssuer.annualRateBps: 20% / 12% / 8% of remaining cap, then 5% long-run. */
export const zkSysAnnualRateBps = (yearIndex: bigint): bigint => {
  if (yearIndex === 0n) return ZKSYS_YEAR_1_RATE_BPS;
  if (yearIndex === 1n) return ZKSYS_YEAR_2_RATE_BPS;
  if (yearIndex === 2n) return ZKSYS_YEAR_3_RATE_BPS;
  return ZKSYS_LONG_RUN_RATE_BPS;
};

/**
 * Mirror of ZkSysIssuer.cumulativeScheduledRewards. Computes the total rewards
 * scheduled through `periodsElapsed` full periods. bigint division floors,
 * matching Solidity's Math.mulDiv rounding-down behavior.
 */
export const zkSysCumulativeScheduledRewards = (
  periodsElapsed: bigint,
  maxSupply: bigint,
  periodsPerYear: bigint
): bigint => {
  let scheduledRewards = 0n;
  let remainingPeriods = periodsElapsed;
  let yearIndex = 0n;

  while (remainingPeriods !== 0n && scheduledRewards < maxSupply) {
    let periodsInYear = remainingPeriods;
    if (periodsInYear > periodsPerYear) {
      periodsInYear = periodsPerYear;
    }

    const remainingSupply = maxSupply - scheduledRewards;
    const annualEmission = (remainingSupply * zkSysAnnualRateBps(yearIndex)) / ZKSYS_BPS_DENOMINATOR;
    if (annualEmission === 0n) {
      return scheduledRewards;
    }
    scheduledRewards += (annualEmission * periodsInYear) / periodsPerYear;

    remainingPeriods -= periodsInYear;
    yearIndex += 1n;
  }

  return scheduledRewards;
};

/** Emission scheduled for a single period (period index is 0-based). */
export const zkSysPeriodEmission = (period: bigint, maxSupply: bigint, periodsPerYear: bigint): bigint => {
  return (
    zkSysCumulativeScheduledRewards(period + 1n, maxSupply, periodsPerYear) -
    zkSysCumulativeScheduledRewards(period, maxSupply, periodsPerYear)
  );
};

/** Mirror of ZkSysIssuer.currentPeriod for an arbitrary timestamp (seconds). */
export const zkSysPeriodAt = (timestampSec: bigint, startTimeSec: bigint, periodSeconds: bigint): bigint => {
  if (periodSeconds === 0n || timestampSec < startTimeSec) return 0n;
  return (timestampSec - startTimeSec) / periodSeconds;
};

/** Unix timestamp (seconds) at which `period` closes (i.e. period + 1 begins). */
export const zkSysPeriodCloseTime = (period: bigint, startTimeSec: bigint, periodSeconds: bigint): bigint => {
  return startTimeSec + (period + 1n) * periodSeconds;
};

/** Unix timestamp (seconds) at which a pending weight with `effectivePeriod` becomes activatable. */
export const zkSysEffectivePeriodStartTime = (
  effectivePeriod: bigint,
  startTimeSec: bigint,
  periodSeconds: bigint
): bigint => {
  return startTimeSec + effectivePeriod * periodSeconds;
};

/**
 * Rewards scheduled for closed periods that nobody has pushed through
 * `distribute()` yet. These do not show up in `pendingRewards` until
 * distribution happens.
 */
export const zkSysUndistributedRewards = (params: {
  currentPeriod: bigint;
  totalScheduledRewards: bigint;
  maxSupply: bigint;
  periodsPerYear: bigint;
}): bigint => {
  const scheduled = zkSysCumulativeScheduledRewards(params.currentPeriod, params.maxSupply, params.periodsPerYear);
  return scheduled > params.totalScheduledRewards ? scheduled - params.totalScheduledRewards : 0n;
};

/** Account's share of one period's emission given its active weight. */
export const zkSysProjectedPeriodRewards = (weight: bigint, totalWeight: bigint, periodEmission: bigint): bigint => {
  if (totalWeight === 0n || weight === 0n) return 0n;
  return (periodEmission * weight) / totalWeight;
};

/** Token amount (wei) as a display number; float precision is fine for UI. */
export const zkSysTokensNumber = (amount: bigint, decimals = 18): number => {
  return Number(amount) / 10 ** decimals;
};

/** Compact display amount: "0.0421", "12.5", "1,250", "1.25M", "210M". */
export const zkSysFormatTokenCompact = (amount: bigint, decimals = 18): string => {
  const value = zkSysTokensNumber(amount, decimals);
  if (value !== 0 && Math.abs(value) < 0.0001) return "<0.0001";
  const compact = Math.abs(value) >= 100_000;
  return new Intl.NumberFormat("en-US", {
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 2 : Math.abs(value) >= 100 ? 2 : 4,
  }).format(value);
};

/** Share of `part` in `total` as a percent string, floored at "<0.01%". */
export const zkSysFormatShare = (part: bigint, total: bigint): string => {
  if (total === 0n || part === 0n) return "0%";
  const bps = (part * 1_000_000n) / total; // hundredths of a bps
  const percent = Number(bps) / 10_000;
  if (percent < 0.01) return "<0.01%";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(percent)}%`;
};

/** Human readable duration like "2d 5h" / "5h 12m" / "12m" / "<1m". */
export const zkSysFormatDuration = (seconds: number): string => {
  if (seconds <= 0) return "0m";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
};
