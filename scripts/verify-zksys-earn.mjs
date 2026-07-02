/* eslint-disable no-console */
// SYSCOIN: one-off sanity check of zkSYS Earn reads against live Tanenbaum
// contracts. Run with: node --experimental-strip-types scripts/verify-zksys-earn.mjs
import { createPublicClient, formatUnits, http, parseAbi } from "viem";

const client = createPublicClient({ transport: http("https://rpc-zk.tanenbaum.io") });

const issuer = "0x9e40c2d8523A4770A702BBD26d1ddf8539B9aEf5";
const registry = "0xB7fc270CBf9e47c1157c205aa25341cce4280f9C";
const vault = "0xC94d9C7A71037bAa1Ceb0a3ca4B0C241b8b41C6B";
const token = "0x6EBb170f69D886916D9ee9E585CE39E626CbC35d";
const membership = "0x0b8647BB8f5A25D1e2a599c7805D39Dc0D876b7B";

const issuerAbi = parseAbi([
  "function currentPeriod() view returns (uint256)",
  "function startTime() view returns (uint256)",
  "function periodSeconds() view returns (uint256)",
  "function periodsPerYear() view returns (uint256)",
  "function totalScheduledRewards() view returns (uint256)",
  "function lastDistributedPeriod() view returns (uint256)",
  "function cumulativeScheduledRewards(uint256) view returns (uint256)",
]);
const registryAbi = parseAbi([
  "function totalWeight() view returns (uint256)",
  "function activationDelayPeriods() view returns (uint256)",
]);
const vaultAbi = parseAbi(["function totalStaked() view returns (uint256)"]);
const tokenAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
]);
const membershipAbi = parseAbi(["function activeSentryNodeCount() view returns (uint256)"]);

const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });

const [
  currentPeriod,
  startTime,
  periodSeconds,
  periodsPerYear,
  totalScheduledRewards,
  lastDistributedPeriod,
  totalWeight,
  activationDelayPeriods,
  totalStaked,
  totalSupply,
  maxSupply,
  sentryCount,
] = await Promise.all([
  read(issuer, issuerAbi, "currentPeriod"),
  read(issuer, issuerAbi, "startTime"),
  read(issuer, issuerAbi, "periodSeconds"),
  read(issuer, issuerAbi, "periodsPerYear"),
  read(issuer, issuerAbi, "totalScheduledRewards"),
  read(issuer, issuerAbi, "lastDistributedPeriod"),
  read(registry, registryAbi, "totalWeight"),
  read(registry, registryAbi, "activationDelayPeriods"),
  read(vault, vaultAbi, "totalStaked"),
  read(token, tokenAbi, "totalSupply"),
  read(token, tokenAbi, "maxSupply"),
  read(membership, membershipAbi, "activeSentryNodeCount"),
]);

console.log("currentPeriod          ", currentPeriod.toString());
console.log("startTime              ", new Date(Number(startTime) * 1000).toISOString());
console.log("periodSeconds          ", periodSeconds.toString());
console.log("periodsPerYear         ", periodsPerYear.toString());
console.log("activationDelayPeriods ", activationDelayPeriods.toString());
console.log("totalStaked            ", formatUnits(totalStaked, 18), "SYS");
console.log("totalWeight            ", formatUnits(totalWeight, 18));
console.log("totalSupply            ", formatUnits(totalSupply, 18), "ZKSYS");
console.log("maxSupply              ", formatUnits(maxSupply, 18), "ZKSYS");
console.log("totalScheduledRewards  ", formatUnits(totalScheduledRewards, 18), "ZKSYS");
console.log("lastDistributedPeriod  ", lastDistributedPeriod.toString());
console.log("activeSentryNodeCount  ", sentryCount.toString());

// Cross-check the TS schedule mirror against the on-chain implementation.
const { zkSysCumulativeScheduledRewards } = await import("../utils/zksysEarn.ts").catch(() => ({}));
for (const periods of [1n, currentPeriod, 365n, 730n, 1095n, 4000n]) {
  const onChain = await read(issuer, issuerAbi, "cumulativeScheduledRewards", [periods]);
  let mirror = "n/a (ts import unavailable)";
  if (zkSysCumulativeScheduledRewards) {
    const local = zkSysCumulativeScheduledRewards(periods, maxSupply, periodsPerYear);
    mirror = local === onChain ? "MATCH" : `MISMATCH local=${local}`;
  }
  console.log(`cumulativeScheduledRewards(${periods})`, formatUnits(onChain, 18), mirror);
}
