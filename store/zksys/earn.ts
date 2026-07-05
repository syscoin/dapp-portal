import {
  createPublicClient,
  decodeEventLog,
  http,
  isAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";

import {
  ZKSYS_GAS_TANK_ABI,
  ZKSYS_ISSUER_ABI,
  ZKSYS_MEMBERSHIP_REGISTRY_ABI,
  ZKSYS_REWARD_WEIGHT_REGISTRY_ABI,
  ZKSYS_STAKING_VAULT_ABI,
  ZKSYS_TOKEN_ABI,
} from "@/data/abis/zksysEarnAbi";
import { getZkSysEarnContracts } from "@/data/zksys";
import { fetchZkSysContractLogs } from "@/utils/zksysBlockscout";
import { zkSysPeriodCloseTime, zkSysUndistributedRewards } from "@/utils/zksysEarn";

// SYSCOIN: immutable issuer/registry parameters, read once per network.
export type ZkSysEarnStaticConfig = {
  startTime: bigint;
  periodSeconds: bigint;
  periodsPerYear: bigint;
  activationDelayPeriods: bigint;
  maxSupply: bigint;
};

export type ZkSysEarnNetworkStats = {
  totalStaked: bigint;
  totalWeight: bigint;
  currentPeriod: bigint;
  totalScheduledRewards: bigint;
  scheduledUnclaimedRewards: bigint;
  lastDistributedPeriod: bigint;
  tokenTotalSupply: bigint;
  activeSentryNodeCount: bigint;
};

export type ZkSysGasTankStats = {
  totalCredits: bigint;
  surplus: bigint;
};

export type ZkSysGasTankPosition = {
  credit: bigint;
  allowance: bigint;
};

export type ZkSysEarnUserPosition = {
  stake: bigint;
  activeWeight: bigint;
  activeStakeWeight: bigint;
  activeSentryNodeWeight: bigint;
  pendingStakeWeight: bigint;
  pendingStakeEffectivePeriod: bigint;
  pendingSentryNodeWeight: bigint;
  pendingSentryNodeEffectivePeriod: bigint;
  pendingRewards: bigint;
  tokenBalance: bigint;
  isActiveSentryNode: boolean;
};

export const useZkSysEarnStore = defineStore("zkSysEarn", () => {
  const onboardStore = useOnboardStore();
  const { account } = storeToRefs(onboardStore);
  const { selectedNetwork } = storeToRefs(useNetworkStore());

  const earnContracts = computed(() => getZkSysEarnContracts(selectedNetwork.value));
  const isEarnAvailable = computed(() => !!earnContracts.value);

  // SYSCOIN: dedicated L2 read client so the dashboard works even while the
  // wallet is connected to L1 (or not connected at all).
  let publicClient: PublicClient | undefined;
  const getEarnPublicClient = () => {
    if (!publicClient) {
      publicClient = createPublicClient({ transport: http(selectedNetwork.value.rpcUrl) });
    }
    return publicClient;
  };

  const requireContracts = () => {
    const contracts = earnContracts.value;
    if (!contracts) throw new Error(`zkSYS Earn is not available on ${selectedNetwork.value.name}`);
    return contracts;
  };

  const {
    result: staticConfig,
    inProgress: staticConfigInProgress,
    error: staticConfigError,
    execute: requestStaticConfig,
  } = usePromise<ZkSysEarnStaticConfig>(async () => {
    const contracts = requireContracts();
    const client = getEarnPublicClient();
    const [startTime, periodSeconds, periodsPerYear, activationDelayPeriods, maxSupply] = await Promise.all([
      client.readContract({ address: contracts.issuer, abi: ZKSYS_ISSUER_ABI, functionName: "startTime" }),
      client.readContract({ address: contracts.issuer, abi: ZKSYS_ISSUER_ABI, functionName: "periodSeconds" }),
      client.readContract({ address: contracts.issuer, abi: ZKSYS_ISSUER_ABI, functionName: "periodsPerYear" }),
      client.readContract({
        address: contracts.rewardWeightRegistry,
        abi: ZKSYS_REWARD_WEIGHT_REGISTRY_ABI,
        functionName: "activationDelayPeriods",
      }),
      client.readContract({ address: contracts.token, abi: ZKSYS_TOKEN_ABI, functionName: "maxSupply" }),
    ]);
    return { startTime, periodSeconds, periodsPerYear, activationDelayPeriods, maxSupply };
  });

  const {
    result: networkStats,
    inProgress: networkStatsInProgress,
    error: networkStatsError,
    execute: requestNetworkStats,
    reset: resetNetworkStats,
  } = usePromise<ZkSysEarnNetworkStats>(
    async () => {
      const contracts = requireContracts();
      const client = getEarnPublicClient();
      const [
        totalStaked,
        totalWeight,
        currentPeriod,
        totalScheduledRewards,
        scheduledUnclaimedRewards,
        lastDistributedPeriod,
        tokenTotalSupply,
        activeSentryNodeCount,
      ] = await Promise.all([
        client.readContract({
          address: contracts.stakingVault,
          abi: ZKSYS_STAKING_VAULT_ABI,
          functionName: "totalStaked",
        }),
        client.readContract({
          address: contracts.rewardWeightRegistry,
          abi: ZKSYS_REWARD_WEIGHT_REGISTRY_ABI,
          functionName: "totalWeight",
        }),
        client.readContract({ address: contracts.issuer, abi: ZKSYS_ISSUER_ABI, functionName: "currentPeriod" }),
        client.readContract({
          address: contracts.issuer,
          abi: ZKSYS_ISSUER_ABI,
          functionName: "totalScheduledRewards",
        }),
        client.readContract({
          address: contracts.issuer,
          abi: ZKSYS_ISSUER_ABI,
          functionName: "scheduledUnclaimedRewards",
        }),
        client.readContract({
          address: contracts.issuer,
          abi: ZKSYS_ISSUER_ABI,
          functionName: "lastDistributedPeriod",
        }),
        client.readContract({ address: contracts.token, abi: ZKSYS_TOKEN_ABI, functionName: "totalSupply" }),
        client.readContract({
          address: contracts.membershipRegistry,
          abi: ZKSYS_MEMBERSHIP_REGISTRY_ABI,
          functionName: "activeSentryNodeCount",
        }),
      ]);
      return {
        totalStaked,
        totalWeight,
        currentPeriod,
        totalScheduledRewards,
        scheduledUnclaimedRewards,
        lastDistributedPeriod,
        tokenTotalSupply,
        activeSentryNodeCount,
      };
    },
    { cache: 15_000 }
  );

  const {
    result: userPosition,
    inProgress: userPositionInProgress,
    error: userPositionError,
    execute: requestUserPosition,
    reset: resetUserPosition,
  } = usePromise<ZkSysEarnUserPosition | undefined>(
    async () => {
      const accountAddress = account.value.address;
      // SYSCOIN: wallet reconnect can briefly surface an undefined address;
      // treat that as "no position" instead of a failed request.
      if (!accountAddress || !isAddress(accountAddress)) return undefined;

      const contracts = requireContracts();
      const client = getEarnPublicClient();
      const address = accountAddress as Address;
      const [stake, activeWeight, weightComponents, pendingWeight, pendingRewards, tokenBalance, isActiveSentryNode] =
        await Promise.all([
          client.readContract({
            address: contracts.stakingVault,
            abi: ZKSYS_STAKING_VAULT_ABI,
            functionName: "stakeOf",
            args: [address],
          }),
          client.readContract({
            address: contracts.rewardWeightRegistry,
            abi: ZKSYS_REWARD_WEIGHT_REGISTRY_ABI,
            functionName: "weightOf",
            args: [address],
          }),
          client.readContract({
            address: contracts.rewardWeightRegistry,
            abi: ZKSYS_REWARD_WEIGHT_REGISTRY_ABI,
            functionName: "weightComponents",
            args: [address],
          }),
          client.readContract({
            address: contracts.rewardWeightRegistry,
            abi: ZKSYS_REWARD_WEIGHT_REGISTRY_ABI,
            functionName: "pendingWeightComponents",
            args: [address],
          }),
          client.readContract({
            address: contracts.issuer,
            abi: ZKSYS_ISSUER_ABI,
            functionName: "pendingRewards",
            args: [address],
          }),
          client.readContract({
            address: contracts.token,
            abi: ZKSYS_TOKEN_ABI,
            functionName: "balanceOf",
            args: [address],
          }),
          client.readContract({
            address: contracts.membershipRegistry,
            abi: ZKSYS_MEMBERSHIP_REGISTRY_ABI,
            functionName: "isActiveSentryNode",
            args: [address],
          }),
        ]);

      return {
        stake,
        activeWeight,
        activeStakeWeight: weightComponents.stakeWeight,
        activeSentryNodeWeight: weightComponents.sentryNodeWeight,
        pendingStakeWeight: pendingWeight.stakeWeight,
        pendingStakeEffectivePeriod: pendingWeight.stakeEffectivePeriod,
        pendingSentryNodeWeight: pendingWeight.sentryNodeWeight,
        pendingSentryNodeEffectivePeriod: pendingWeight.sentryNodeEffectivePeriod,
        pendingRewards,
        tokenBalance,
        isActiveSentryNode,
      };
    },
    { cache: 15_000 }
  );

  // --- Gas tank (prepaid zkSYS gas, replaces the retired paymaster path) ---
  const gasTankAddress = computed(() => earnContracts.value?.gasTank);

  // SYSCOIN: the tank address is pre-computed (deterministic CREATE2), so gate
  // every gas-tank feature on code actually existing at that address.
  const { result: gasTankDeployed, execute: executeGasTankDeployed } = usePromise<boolean>(
    async () => {
      const address = gasTankAddress.value;
      if (!address) return false;
      const code = await getEarnPublicClient().getCode({ address });
      return !!code && code !== "0x";
    },
    // Short TTL so a "not deployed yet" result expires and the periodic
    // stats/position polls re-check code, letting the UI self-activate once
    // the deploy lands without a page reload.
    { cache: 30_000 }
  );
  const requestGasTankDeployed = async (): Promise<boolean> => {
    // Deployment is permanent: once code has been seen, skip further checks.
    if (gasTankDeployed.value === true) return true;
    return (await executeGasTankDeployed()) === true;
  };
  const isGasTankAvailable = computed(() => !!gasTankAddress.value && gasTankDeployed.value === true);

  const {
    result: gasTankStats,
    inProgress: gasTankStatsInProgress,
    error: gasTankStatsError,
    execute: requestGasTankStats,
  } = usePromise<ZkSysGasTankStats | undefined>(
    async () => {
      const address = gasTankAddress.value;
      if (!address || !(await requestGasTankDeployed())) return undefined;
      const client = getEarnPublicClient();
      const [totalCredits, surplus] = await Promise.all([
        client.readContract({ address, abi: ZKSYS_GAS_TANK_ABI, functionName: "totalCredits" }),
        client.readContract({ address, abi: ZKSYS_GAS_TANK_ABI, functionName: "surplus" }),
      ]);
      return { totalCredits, surplus };
    },
    { cache: 15_000 }
  );

  /**
   * Cumulative zkSYS burned through gas-tank surplus burns, summed from token
   * Transfer events to the zero address. Bounded by the indexed log window, so
   * treat it as "burned so far in the covered range".
   */
  const {
    result: burnedTotal,
    inProgress: burnedTotalInProgress,
    error: burnedTotalError,
    execute: requestBurnedTotal,
  } = usePromise<bigint>(
    async () => {
      const contracts = requireContracts();
      const apiUrl = selectedNetwork.value.syscoinBridge?.l2BlockscoutApiUrl;
      if (!apiUrl) return 0n;

      const logs = await fetchZkSysContractLogs(apiUrl, contracts.token);
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

  const requestNetworkSummary = async (options?: { force?: boolean; forceBurnedTotal?: boolean }) => {
    await Promise.all([
      requestNetworkStats({ force: options?.force }),
      // Blockscout logs are best-effort and heavier than direct RPC reads, so
      // keep the burned total cached unless a user/tx-triggered refresh asks to
      // force it. A log indexer outage should not block live network stats.
      requestBurnedTotal({ force: options?.forceBurnedTotal }).catch(() => undefined),
    ]);
  };

  const {
    result: gasTankPosition,
    inProgress: gasTankPositionInProgress,
    error: gasTankPositionError,
    execute: requestGasTankPosition,
    reset: resetGasTankPosition,
  } = usePromise<ZkSysGasTankPosition | undefined>(
    async () => {
      const accountAddress = account.value.address;
      if (!accountAddress || !isAddress(accountAddress)) return undefined;
      const address = gasTankAddress.value;
      if (!address || !(await requestGasTankDeployed())) return undefined;

      const contracts = requireContracts();
      const client = getEarnPublicClient();
      const owner = accountAddress as Address;
      const [credit, allowance] = await Promise.all([
        client.readContract({ address, abi: ZKSYS_GAS_TANK_ABI, functionName: "creditOf", args: [owner] }),
        client.readContract({
          address: contracts.token,
          abi: ZKSYS_TOKEN_ABI,
          functionName: "allowance",
          args: [owner, address],
        }),
      ]);
      return { credit, allowance };
    },
    { cache: 15_000 }
  );

  const refresh = async () => {
    if (!isEarnAvailable.value) return;
    await Promise.all([
      requestStaticConfig(),
      requestNetworkSummary({ force: true, forceBurnedTotal: true }),
      requestUserPosition({ force: true }),
      requestGasTankStats({ force: true }),
      requestGasTankPosition({ force: true }),
    ]);
  };

  /*
   * SYSCOIN: pendingWeightComponents only reports queued increases (decreases
   * apply immediately in the registry), so a non-zero pending target weight is
   * the exact "has pending weight" signal used by the contract itself.
   */
  const hasPendingStakeWeight = computed(() => (userPosition.value?.pendingStakeWeight ?? 0n) > 0n);
  const hasPendingSentryWeight = computed(() => (userPosition.value?.pendingSentryNodeWeight ?? 0n) > 0n);
  const hasPendingWeight = computed(() => hasPendingStakeWeight.value || hasPendingSentryWeight.value);

  const isPendingStakeActivatable = computed(() => {
    if (!hasPendingStakeWeight.value || !networkStats.value || !userPosition.value) return false;
    return networkStats.value.currentPeriod >= userPosition.value.pendingStakeEffectivePeriod;
  });
  const isPendingSentryActivatable = computed(() => {
    if (!hasPendingSentryWeight.value || !networkStats.value || !userPosition.value) return false;
    return networkStats.value.currentPeriod >= userPosition.value.pendingSentryNodeEffectivePeriod;
  });
  const isPendingWeightActivatable = computed(
    () => isPendingStakeActivatable.value || isPendingSentryActivatable.value
  );

  /** Queued stake weight increase (pending target minus currently active stake weight). */
  const pendingStakeWeightDelta = computed(() => {
    if (!hasPendingStakeWeight.value || !userPosition.value) return 0n;
    const delta = userPosition.value.pendingStakeWeight - userPosition.value.activeStakeWeight;
    return delta > 0n ? delta : 0n;
  });

  /** Queued sentry-node weight increase (pending target minus currently active sentry weight). */
  const pendingSentryWeightDelta = computed(() => {
    if (!hasPendingSentryWeight.value || !userPosition.value) return 0n;
    const delta = userPosition.value.pendingSentryNodeWeight - userPosition.value.activeSentryNodeWeight;
    return delta > 0n ? delta : 0n;
  });

  /** Combined queued weight increase across both components. */
  const pendingWeightDelta = computed(() => pendingStakeWeightDelta.value + pendingSentryWeightDelta.value);

  /** Rewards scheduled for closed periods that still need a permissionless distribute() call. */
  const undistributedRewards = computed(() => {
    if (!networkStats.value || !staticConfig.value) return 0n;
    return zkSysUndistributedRewards({
      currentPeriod: networkStats.value.currentPeriod,
      totalScheduledRewards: networkStats.value.totalScheduledRewards,
      maxSupply: staticConfig.value.maxSupply,
      periodsPerYear: staticConfig.value.periodsPerYear,
    });
  });

  /** Unix seconds when the current period closes. */
  const currentPeriodCloseTime = computed(() => {
    if (!networkStats.value || !staticConfig.value) return undefined;
    return zkSysPeriodCloseTime(
      networkStats.value.currentPeriod,
      staticConfig.value.startTime,
      staticConfig.value.periodSeconds
    );
  });

  /** Number of user actions currently available (activate weight, claim rewards). */
  const actionableCount = computed(() => {
    let count = 0;
    if (isPendingWeightActivatable.value) count += 1;
    if ((userPosition.value?.pendingRewards ?? 0n) > 0n) count += 1;
    return count;
  });

  onboardStore.subscribeOnAccountChange(() => {
    resetUserPosition();
    resetGasTankPosition();
  });

  return {
    isEarnAvailable,
    earnContracts,
    getEarnPublicClient,

    staticConfig: computed(() => staticConfig.value),
    staticConfigInProgress: computed(() => staticConfigInProgress.value),
    staticConfigError: computed(() => staticConfigError.value),
    requestStaticConfig,

    networkStats: computed(() => networkStats.value),
    networkStatsInProgress: computed(() => networkStatsInProgress.value),
    networkStatsError: computed(() => networkStatsError.value),
    requestNetworkStats,
    requestNetworkSummary,
    resetNetworkStats,

    userPosition: computed(() => userPosition.value),
    userPositionInProgress: computed(() => userPositionInProgress.value),
    userPositionError: computed(() => userPositionError.value),
    requestUserPosition,
    resetUserPosition,

    gasTankAddress,
    isGasTankAvailable,
    requestGasTankDeployed,
    gasTankStats: computed(() => gasTankStats.value),
    gasTankStatsInProgress: computed(() => gasTankStatsInProgress.value),
    gasTankStatsError: computed(() => gasTankStatsError.value),
    requestGasTankStats,
    burnedTotal: computed(() => burnedTotal.value),
    burnedTotalInProgress: computed(() => burnedTotalInProgress.value),
    burnedTotalError: computed(() => burnedTotalError.value),
    requestBurnedTotal,
    gasTankPosition: computed(() => gasTankPosition.value),
    gasTankPositionInProgress: computed(() => gasTankPositionInProgress.value),
    gasTankPositionError: computed(() => gasTankPositionError.value),
    requestGasTankPosition,
    resetGasTankPosition,

    refresh,

    hasPendingStakeWeight,
    hasPendingSentryWeight,
    hasPendingWeight,
    isPendingStakeActivatable,
    isPendingSentryActivatable,
    isPendingWeightActivatable,
    pendingStakeWeightDelta,
    pendingSentryWeightDelta,
    pendingWeightDelta,
    undistributedRewards,
    currentPeriodCloseTime,
    actionableCount,
  };
});
