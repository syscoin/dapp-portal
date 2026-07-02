import type { ZkSyncNetwork } from "@/data/networks";
import type { Address } from "viem";

// SYSCOIN: canonical zkSYS Earn (native SYS staking + zkSYS issuance) proxy
// contracts. All addresses are TransparentUpgradeableProxy instances deployed
// via CREATE2 by zksys-l2-bootstrap.sh in zksync-os-server.
export type ZkSysEarnContracts = {
  /** SyscoinZKSYSToken proxy (zkSYS ERC20, 210M max supply) */
  token: Address;
  /** ZkSysMembershipRegistry proxy (sentry-node facts mirrored from L1) */
  membershipRegistry: Address;
  /** ZkSysRewardWeightRegistry proxy (stake + sentry weight, pending activation) */
  rewardWeightRegistry: Address;
  /** ZkSysIssuer proxy (scheduled emission, distribute/claim) */
  issuer: Address;
  /** ZkSysNativeStakingVault proxy (payable deposit of native SYS) */
  stakingVault: Address;
  /** Optional PaliFixedRateTokenPaymaster (burns zkSYS 1:1 for gas) */
  paymaster?: Address;
};

export const zkSysEarnContracts: Record<string, ZkSysEarnContracts> = {
  "syscoin-tanenbaum-zksys": {
    token: "0x6EBb170f69D886916D9ee9E585CE39E626CbC35d",
    membershipRegistry: "0x0b8647BB8f5A25D1e2a599c7805D39Dc0D876b7B",
    rewardWeightRegistry: "0xB7fc270CBf9e47c1157c205aa25341cce4280f9C",
    issuer: "0x9e40c2d8523A4770A702BBD26d1ddf8539B9aEf5",
    stakingVault: "0xC94d9C7A71037bAa1Ceb0a3ca4B0C241b8b41C6B",
  },
};

export const getZkSysEarnContracts = (network: ZkSyncNetwork): ZkSysEarnContracts | undefined => {
  return zkSysEarnContracts[network.key];
};

export const isZkSysEarnNetwork = (network: ZkSyncNetwork) => {
  return !!getZkSysEarnContracts(network);
};
