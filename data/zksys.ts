import type { ZkSyncNetwork } from "@/data/networks";
import type { Address } from "viem";

// SYSCOIN: canonical zkSYS Earn (native SYS staking + zkSYS issuance) proxy
// contracts. All addresses are TransparentUpgradeableProxy instances deployed
// via CREATE2 by zksys-l2-bootstrap.sh in zksync-os-server.
// SYSCOIN: These bindings match the qualified fresh v32 bootstrap, not v31.
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
  /**
   * Optional ZkSysGasTank (non-upgradeable, no proxy). Prepaid zkSYS gas
   * ledger debited 1:1 by the patched bootloader; replaces the retired Pali
   * paymaster path. The UI only enables gas-tank features once code exists
   * at this address, so a pre-computed CREATE2 address is safe to list here.
   */
  gasTank?: Address;
};

export const zkSysEarnContracts: Record<string, ZkSysEarnContracts> = {
  "syscoin-tanenbaum-zksys": {
    token: "0x6EBb170f69D886916D9ee9E585CE39E626CbC35d",
    membershipRegistry: "0xc3eadb6c606a9e2a487d877e1ad37d7c3b6bb598",
    rewardWeightRegistry: "0xf321225f85342c4a77a2b6882b7f34aa6c70482a",
    issuer: "0xe9b333f491325bc388e049e199d4b2e325893c36",
    stakingVault: "0x459b3873bdf3cc81f647bb40b67417af99de934a",
    // Deterministic CREATE2 address (salt "zksys-gas-tank", token ctor arg)
    // from zksys-l2-bootstrap.sh; feature stays hidden until deployed.
    gasTank: "0xb49943ea232624dd4aa63e18186076c6c99a68ef",
  },
};

export const getZkSysEarnContracts = (network: ZkSyncNetwork): ZkSysEarnContracts | undefined => {
  return zkSysEarnContracts[network.key];
};

export const isZkSysEarnNetwork = (network: ZkSyncNetwork) => {
  return !!getZkSysEarnContracts(network);
};
