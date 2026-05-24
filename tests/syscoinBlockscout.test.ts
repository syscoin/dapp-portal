import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  attachSyscoinL1MappingsToL2Tokens,
  mapSyscoinBlockscoutToken,
  mapSyscoinBlockscoutTokenBalance,
  mergeSyscoinTokens,
  resolveSyscoinL2TokenMappings,
} from "../utils/syscoinBlockscout";

const l1Dai = "0x2d2e508c8056c3D92745dC2C39E5Cc316de79C0F";
const l2Dai = "0x4444444444444444444444444444444444444444";

const officialTokens = [
  {
    address: l2Dai,
    l1Address: l1Dai,
    l2Address: l2Dai,
    symbol: "DAI.sys",
    name: "Syscoin DAI",
    decimals: 18,
  },
];

describe("syscoin Blockscout mapping", () => {
  it("maps L1 token listings and keeps official bridge metadata", () => {
    const token = mapSyscoinBlockscoutToken(
      {
        address: l1Dai,
        decimals: "18",
        name: "DAI",
        symbol: "DAI",
        type: "ERC-20",
      },
      "L1",
      officialTokens
    );

    assert.equal(token.address, l1Dai);
    assert.equal(token.l1Address, l1Dai);
    assert.equal(token.l2Address, l2Dai);
    assert.equal(token.symbol, "DAI.sys");
    assert.equal(token.name, "Syscoin DAI");
  });

  it("does not mark unknown L2-created tokens as withdrawable", () => {
    const token = mapSyscoinBlockscoutToken(
      {
        address: "0x5555555555555555555555555555555555555555",
        decimals: "6",
        name: "Local Token",
        symbol: "LOCAL",
        type: "ERC-20",
      },
      "L2",
      officialTokens
    );

    assert.equal(token.l1Address, undefined);
    assert.equal(token.symbol, "LOCAL");
    assert.equal(token.decimals, 6);
  });

  it("maps Blockscout token balances into portal balances", () => {
    const balance = mapSyscoinBlockscoutTokenBalance(
      {
        token: {
          address: l1Dai,
          decimals: "18",
          name: "DAI",
          symbol: "DAI",
        },
        value: "123",
      },
      "L1",
      officialTokens
    );

    assert.equal(balance.address, l1Dai);
    assert.equal(balance.amount, "123");
    assert.equal(balance.l2Address, l2Dai);
  });

  it("keeps curated tokens before explorer tokens when merging", () => {
    const merged = mergeSyscoinTokens(officialTokens, [
      {
        address: l2Dai,
        symbol: "Spoofed DAI",
        decimals: 18,
      },
    ]);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].symbol, "DAI.sys");
  });

  it("resolves L1 to L2 mapping through the L2 AssetRouter", async () => {
    const publicClient = {
      readContract: async () => l2Dai,
    };

    const mappings = await resolveSyscoinL2TokenMappings(publicClient as any, [
      {
        address: l1Dai,
        symbol: "DAI",
        decimals: 18,
      },
    ]);

    assert.equal(mappings.get(l1Dai.toLowerCase())?.l2Address, l2Dai);
  });

  it("attaches L1 mapping to L2 Blockscout balances", () => {
    const [mappedToken] = attachSyscoinL1MappingsToL2Tokens(
      [
        {
          address: l2Dai,
          symbol: "DAI",
          decimals: 18,
        },
      ],
      officialTokens
    );

    assert.equal(mappedToken.l1Address, l1Dai);
    assert.equal(mappedToken.l2Address, l2Dai);
  });
});
