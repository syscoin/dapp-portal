import { $fetch } from "ofetch";
import { decodeEventLog, formatUnits, getAddress, isAddressEqual, zeroAddress, type Address, type Hex } from "viem";

import {
  ZKSYS_ISSUER_ABI,
  ZKSYS_REWARD_WEIGHT_REGISTRY_ABI,
  ZKSYS_STAKING_VAULT_ABI,
  ZKSYS_TOKEN_ABI,
} from "@/data/abis/zksysEarnAbi";
import { zkSysCumulativeScheduledRewards, zkSysPeriodAt } from "@/utils/zksysEarn";

import type { ZkSysEarnStaticConfig } from "@/store/zksys/earn";

export type TimeSeriesPoint = { x: number; y: number };
export type PeriodBarPoint = { period: number; distributed: number; claimed: number };

export type IssuanceSchedule = {
  /** Cumulative scheduled supply, monthly resolution */
  points: TimeSeriesPoint[];
  capTokens: number;
  nowMs: number;
  mintedTokens: number;
};

type BlockscoutLogItem = {
  data: Hex;
  topics: (Hex | null)[];
  block_number: number;
  block_timestamp?: string | null;
  transaction_hash?: string;
};

type BlockscoutCollection<T> = {
  items: T[];
  next_page_params?: Record<string, string | number | boolean | null> | null;
};

type ContractLog = {
  data: Hex;
  topics: [Hex, ...Hex[]];
  blockNumber: bigint;
  timestampMs?: number;
};

const ISSUANCE_CHART_YEARS = 12;
const LOG_PAGES_LIMIT = 10; // 50 logs per Blockscout page
const BLOCK_TIMESTAMP_FETCH_LIMIT = 300;

const toTokens = (amount: bigint) => Number(formatUnits(amount, 18));

// SYSCOIN: Blockscout v2 logs endpoint, newest first. Mirrors the pagination
// handling in utils/syscoinBlockscout.ts but without the ERC-20 type param.
const fetchContractLogs = async (apiUrl: string, address: Address, maxPages = LOG_PAGES_LIMIT) => {
  const items: BlockscoutLogItem[] = [];
  let nextPageParams: BlockscoutCollection<BlockscoutLogItem>["next_page_params"] = {};
  const seenPageCursors = new Set<string>();

  for (let page = 0; page < maxPages && nextPageParams !== null; page++) {
    const url = new URL(`${apiUrl.replace(/\/$/, "")}/addresses/${getAddress(address)}/logs`);
    for (const [key, value] of Object.entries(nextPageParams ?? {})) {
      url.searchParams.set(key, value == null ? "" : String(value));
    }

    const cursor = url.searchParams.toString();
    if (seenPageCursors.has(cursor)) break;
    seenPageCursors.add(cursor);

    const response = await $fetch<BlockscoutCollection<BlockscoutLogItem>>(url.toString());
    items.push(...response.items);
    nextPageParams = response.next_page_params ?? null;
  }

  return items
    .filter((item) => item.topics[0])
    .map<ContractLog>((item) => ({
      data: item.data,
      topics: item.topics.filter((topic): topic is Hex => !!topic) as [Hex, ...Hex[]],
      blockNumber: BigInt(item.block_number),
      timestampMs: item.block_timestamp ? new Date(item.block_timestamp).getTime() : undefined,
    }));
};

export default () => {
  const earnStore = useZkSysEarnStore();
  const { selectedNetwork } = storeToRefs(useNetworkStore());

  const l2BlockscoutApiUrl = computed(() => selectedNetwork.value.syscoinBridge?.l2BlockscoutApiUrl);

  // SYSCOIN: not every Blockscout build ships block_timestamp on log items;
  // backfill missing timestamps from the RPC, bounded to keep the page snappy.
  const resolveLogTimestamps = async (logs: ContractLog[]): Promise<ContractLog[]> => {
    const missingBlocks = [...new Set(logs.filter((log) => !log.timestampMs).map((log) => log.blockNumber))];
    if (!missingBlocks.length) return logs;
    if (missingBlocks.length > BLOCK_TIMESTAMP_FETCH_LIMIT) {
      // Keep the most recent events only rather than hammering the RPC.
      const allowed = new Set(missingBlocks.sort((a, b) => (a > b ? -1 : 1)).slice(0, BLOCK_TIMESTAMP_FETCH_LIMIT));
      logs = logs.filter((log) => log.timestampMs || allowed.has(log.blockNumber));
    }

    const client = earnStore.getEarnPublicClient();
    const timestamps = new Map<bigint, number>();
    const blocksToFetch = [...new Set(logs.filter((log) => !log.timestampMs).map((log) => log.blockNumber))];
    const chunkSize = 10;
    for (let i = 0; i < blocksToFetch.length; i += chunkSize) {
      const chunk = blocksToFetch.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (blockNumber) => {
          const block = await client.getBlock({ blockNumber });
          timestamps.set(blockNumber, Number(block.timestamp) * 1000);
        })
      );
    }
    return logs.map((log) => ({ ...log, timestampMs: log.timestampMs ?? timestamps.get(log.blockNumber) }));
  };

  /**
   * Deterministic issuance curve from the ZkSysIssuer schedule. Needs no
   * indexer: 20% / 12% / 8% of remaining cap in years 1-3, then 5% long-run.
   */
  const buildIssuanceSchedule = (staticConfig: ZkSysEarnStaticConfig, tokenTotalSupply: bigint): IssuanceSchedule => {
    const startMs = Number(staticConfig.startTime) * 1000;
    const periodMs = Number(staticConfig.periodSeconds) * 1000;
    const totalPeriods = staticConfig.periodsPerYear * BigInt(ISSUANCE_CHART_YEARS);
    const points: TimeSeriesPoint[] = [];

    const steps = ISSUANCE_CHART_YEARS * 12;
    for (let step = 0; step <= steps; step++) {
      const periods = (totalPeriods * BigInt(step)) / BigInt(steps);
      points.push({
        x: startMs + Number(periods) * periodMs,
        y: toTokens(zkSysCumulativeScheduledRewards(periods, staticConfig.maxSupply, staticConfig.periodsPerYear)),
      });
    }

    return {
      points,
      capTokens: toTokens(staticConfig.maxSupply),
      nowMs: Date.now(),
      mintedTokens: toTokens(tokenTotalSupply),
    };
  };

  /**
   * Total SYS staked in the vault over time. Walks vault events newest-first
   * from the live totalStaked value, so a truncated log window still yields
   * exact values for the covered range.
   */
  const {
    result: stakingHistory,
    inProgress: stakingHistoryInProgress,
    error: stakingHistoryError,
    execute: requestStakingHistory,
  } = usePromise<TimeSeriesPoint[]>(
    async () => {
      const contracts = earnStore.earnContracts;
      const apiUrl = l2BlockscoutApiUrl.value;
      if (!contracts || !apiUrl) return [];
      await earnStore.requestNetworkStats();
      const currentTotal = earnStore.networkStats?.totalStaked ?? 0n;

      const logs = await resolveLogTimestamps(await fetchContractLogs(apiUrl, contracts.stakingVault));
      type StakeEvent = { timestampMs: number; delta: bigint };
      const events: StakeEvent[] = [];
      for (const log of logs) {
        if (!log.timestampMs) continue;
        try {
          const decoded = decodeEventLog({ abi: ZKSYS_STAKING_VAULT_ABI, data: log.data, topics: log.topics });
          if (decoded.eventName === "Deposited") {
            events.push({ timestampMs: log.timestampMs, delta: decoded.args.amount });
          } else if (decoded.eventName === "Withdrawn") {
            events.push({ timestampMs: log.timestampMs, delta: -decoded.args.amount });
          }
        } catch {
          // Not a vault stake event (e.g. proxy admin log); skip.
        }
      }

      // Newest first: subtract deltas to reconstruct running totals backwards.
      events.sort((a, b) => b.timestampMs - a.timestampMs);
      let running = currentTotal;
      const points: TimeSeriesPoint[] = [{ x: Date.now(), y: toTokens(currentTotal) }];
      for (const event of events) {
        points.push({ x: event.timestampMs, y: toTokens(running) });
        running -= event.delta;
      }
      if (events.length) {
        points.push({ x: events[events.length - 1].timestampMs, y: toTokens(running) });
      }
      return points.reverse();
    },
    { cache: 60_000 }
  );

  /** Rewards distributed and claimed per reward period, from issuer events. */
  const {
    result: rewardsHistory,
    inProgress: rewardsHistoryInProgress,
    error: rewardsHistoryError,
    execute: requestRewardsHistory,
  } = usePromise<PeriodBarPoint[]>(
    async () => {
      const contracts = earnStore.earnContracts;
      const apiUrl = l2BlockscoutApiUrl.value;
      if (!contracts || !apiUrl) return [];
      await earnStore.requestStaticConfig();
      const staticConfig = earnStore.staticConfig;

      const logs = await resolveLogTimestamps(await fetchContractLogs(apiUrl, contracts.issuer));
      const byPeriod = new Map<number, { distributed: number; claimed: number }>();
      const bucket = (period: number) => {
        let entry = byPeriod.get(period);
        if (!entry) {
          entry = { distributed: 0, claimed: 0 };
          byPeriod.set(period, entry);
        }
        return entry;
      };

      for (const log of logs) {
        try {
          const decoded = decodeEventLog({ abi: ZKSYS_ISSUER_ABI, data: log.data, topics: log.topics });
          if (decoded.eventName === "RewardsDistributed") {
            bucket(Number(decoded.args.distributedThroughPeriod)).distributed += toTokens(decoded.args.amount);
          } else if (decoded.eventName === "RewardsClaimed" && staticConfig && log.timestampMs) {
            const period = zkSysPeriodAt(
              BigInt(Math.floor(log.timestampMs / 1000)),
              staticConfig.startTime,
              staticConfig.periodSeconds
            );
            bucket(Number(period)).claimed += toTokens(decoded.args.amount);
          }
        } catch {
          // Not an issuer reward event; skip.
        }
      }

      return [...byPeriod.entries()]
        .map(([period, entry]) => ({ period, ...entry }))
        .sort((a, b) => a.period - b.period);
    },
    { cache: 60_000 }
  );

  /**
   * Total reward weight over time, from registry WeightUpdated events. Walks
   * newest-first from the live totalWeight so a truncated log window still
   * yields exact values for the covered range.
   */
  const {
    result: weightHistory,
    inProgress: weightHistoryInProgress,
    error: weightHistoryError,
    execute: requestWeightHistory,
  } = usePromise<TimeSeriesPoint[]>(
    async () => {
      const contracts = earnStore.earnContracts;
      const apiUrl = l2BlockscoutApiUrl.value;
      if (!contracts || !apiUrl) return [];
      await earnStore.requestNetworkStats();
      const currentTotal = earnStore.networkStats?.totalWeight ?? 0n;

      const logs = await resolveLogTimestamps(await fetchContractLogs(apiUrl, contracts.rewardWeightRegistry));
      type WeightEvent = { timestampMs: number; delta: bigint };
      const events: WeightEvent[] = [];
      for (const log of logs) {
        if (!log.timestampMs) continue;
        try {
          const decoded = decodeEventLog({
            abi: ZKSYS_REWARD_WEIGHT_REGISTRY_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "WeightUpdated") {
            events.push({ timestampMs: log.timestampMs, delta: decoded.args.newWeight - decoded.args.oldWeight });
          }
        } catch {
          // Not a registry weight event (e.g. queue or proxy admin log); skip.
        }
      }

      // Newest first: subtract deltas to reconstruct running totals backwards.
      events.sort((a, b) => b.timestampMs - a.timestampMs);
      let running = currentTotal;
      const points: TimeSeriesPoint[] = [{ x: Date.now(), y: toTokens(currentTotal) }];
      for (const event of events) {
        points.push({ x: event.timestampMs, y: toTokens(running) });
        running -= event.delta;
      }
      if (events.length) {
        points.push({ x: events[events.length - 1].timestampMs, y: toTokens(running) });
      }
      return points.reverse();
    },
    { cache: 60_000 }
  );

  /**
   * Cumulative zkSYS burned (gas-tank surplus burns via burnSurplus()),
   * summed from token Transfer events to the zero address. Bounded by the
   * indexed log window, so treat it as "burned so far in the covered range".
   */
  const {
    result: burnedTotal,
    inProgress: burnedTotalInProgress,
    error: burnedTotalError,
    execute: requestBurnedTotal,
  } = usePromise<bigint>(
    async () => {
      const contracts = earnStore.earnContracts;
      const apiUrl = l2BlockscoutApiUrl.value;
      if (!contracts || !apiUrl) return 0n;

      const logs = await fetchContractLogs(apiUrl, contracts.token);
      let burned = 0n;
      for (const log of logs) {
        try {
          const decoded = decodeEventLog({ abi: ZKSYS_TOKEN_ABI, data: log.data, topics: log.topics });
          if (decoded.eventName !== "Transfer") continue;
          if (isAddressEqual(decoded.args.to, zeroAddress)) burned += decoded.args.value;
        } catch {
          // Not an ERC20 transfer (e.g. votes/roles event); skip.
        }
      }
      return burned;
    },
    { cache: 60_000 }
  );

  return {
    buildIssuanceSchedule,

    stakingHistory,
    stakingHistoryInProgress,
    stakingHistoryError,
    requestStakingHistory,

    rewardsHistory,
    rewardsHistoryInProgress,
    rewardsHistoryError,
    requestRewardsHistory,

    weightHistory,
    weightHistoryInProgress,
    weightHistoryError,
    requestWeightHistory,

    burnedTotal,
    burnedTotalInProgress,
    burnedTotalError,
    requestBurnedTotal,
  };
};
