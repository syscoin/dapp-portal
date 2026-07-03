import { parseAbi } from "viem";

// SYSCOIN: minimal ABIs for the zkSYS Earn contracts, mirrored from
// zksync-os-server/contracts/src/zksys/*.sol. Only functions and events the
// portal reads, writes, or decodes from logs are included.

export const ZKSYS_STAKING_VAULT_ABI = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 amount)",
  "function withdrawTo(address receiver, uint256 amount)",
  "function stakeOf(address account) view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "event Deposited(address indexed account, address indexed payer, uint256 amount, uint256 newStake)",
  "event Withdrawn(address indexed account, address indexed receiver, uint256 amount, uint256 newStake)",
]);

export const ZKSYS_REWARD_WEIGHT_REGISTRY_ABI = parseAbi([
  "function weightOf(address account) view returns (uint256)",
  "function weightComponents(address account) view returns ((uint256 stakeWeight, uint256 sentryNodeWeight))",
  "function pendingWeightComponents(address account) view returns ((uint256 stakeWeight, uint256 stakeEffectivePeriod, uint256 sentryNodeWeight, uint256 sentryNodeEffectivePeriod))",
  "function totalWeight() view returns (uint256)",
  "function activationDelayPeriods() view returns (uint256)",
  "function activatePendingWeight()",
  "function activatePendingWeightFor(address account)",
  "event StakeWeightQueued(address indexed account, uint256 activeStakeWeight, uint256 pendingStakeWeight, uint256 effectivePeriod)",
  "event PendingWeightActivated(address indexed account, uint256 oldWeight, uint256 newWeight)",
  "event WeightUpdated(address indexed account, uint256 oldWeight, uint256 newWeight)",
]);

export const ZKSYS_ISSUER_ABI = parseAbi([
  "function distribute() returns (uint256 amount)",
  "function claim(address receiver) returns (uint256 claimed)",
  "function pendingRewards(address account) view returns (uint256)",
  "function currentPeriod() view returns (uint256)",
  "function startTime() view returns (uint256)",
  "function periodSeconds() view returns (uint256)",
  "function periodsPerYear() view returns (uint256)",
  "function totalScheduledRewards() view returns (uint256)",
  "function scheduledUnclaimedRewards() view returns (uint256)",
  "function lastDistributedPeriod() view returns (uint256)",
  "function cumulativeScheduledRewards(uint256 periodsElapsed) view returns (uint256)",
  "event RewardsDistributed(uint256 amount, uint256 indexed distributedThroughPeriod, uint256 accRewardPerWeight)",
  "event RewardsClaimed(address indexed account, address indexed receiver, uint256 amount)",
]);

export const ZKSYS_TOKEN_ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const ZKSYS_GAS_TANK_ABI = parseAbi([
  "function creditOf(address account) view returns (uint256)",
  "function totalCredits() view returns (uint256)",
  "function surplus() view returns (uint256)",
  "function fund(uint256 amount)",
  "function fundFor(address account, uint256 amount)",
  "function withdraw(uint256 amount)",
  "function burnSurplus() returns (uint256 amount)",
  "event Funded(address indexed funder, address indexed account, uint256 amount)",
  "event Withdrawn(address indexed account, uint256 amount)",
  "event SurplusBurned(address indexed caller, uint256 amount)",
]);

export const ZKSYS_MEMBERSHIP_REGISTRY_ABI = parseAbi([
  "function member(address account) view returns ((uint32 sentryNodeCollateralHeight, uint128 sentryNodeWeight))",
  "function isActiveSentryNode(address account) view returns (bool)",
  "function activeSentryNodeCount() view returns (uint256)",
]);
