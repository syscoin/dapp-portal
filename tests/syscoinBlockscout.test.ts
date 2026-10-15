import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { encodeAbiParameters, getAddress, keccak256, zeroAddress, zeroHash } from "viem";
import { $fetch } from "ofetch";
import { beforeEach, describe, it, vi } from "vitest";

import { customBridgeTokens } from "../data/customBridgeTokens";
import { syscoinTanenbaumTokens } from "../data/syscoin";
import { L2_ASSET_ROUTER_ADDRESS, L2_NATIVE_TOKEN_VAULT_ADDRESS } from "../utils/constants";
import {
  attachSyscoinL1MappingsToL2Tokens,
  fetchSyscoinBlockscoutTokenBalances,
  mapSyscoinBlockscoutToken,
  mapSyscoinBlockscoutTokenBalance,
  mergeSyscoinTokens,
  resolveSyscoinL2TokenMappings,
} from "../utils/syscoinBlockscout";

vi.mock("ofetch", () => ({
  $fetch: vi.fn(async () => ({ items: [], next_page_params: null })),
}));

const l1Dai = "0x2d2e508c8056c3D92745dC2C39E5Cc316de79C0F";
const l2Dai = "0x4444444444444444444444444444444444444444";
const fetchMock = vi.mocked($fetch);

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

function registeredFixture(originChainId = 57057n) {
  const l1Token = "0x1111111111111111111111111111111111111111";
  const l2Token = "0x2222222222222222222222222222222222222222";
  const vault = "0x3333333333333333333333333333333333333333";
  const router = "0x4444444444444444444444444444444444444444";
  const originToken = originChainId === 5700n ? l1Token : l2Token;
  const assetId = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }],
      [originChainId, L2_NATIVE_TOKEN_VAULT_ADDRESS, originToken]
    )
  );
  const rootValues: Record<string, unknown> = { assetId, tokenAddress: l1Token, originChainId, originToken };
  const edgeValues: Record<string, unknown> = { assetId, tokenAddress: l2Token, originChainId, originToken };
  const calls: Array<{ side: string; functionName?: string; address: string; blockNumber?: bigint }> = [];
  const client = (side: string, values: Record<string, unknown>, chainId: number, block: bigint) => ({
    getChainId: vi.fn(async () => chainId),
    getBlockNumber: vi.fn(async () => block),
    getCode: vi.fn(async (request: any) => {
      calls.push({ side, ...request });
      return "0x6000";
    }),
    readContract: vi.fn(async (request: any) => {
      calls.push({ side, ...request });
      if (request.functionName === "nativeTokenVault") {
        assert.equal(side, "root");
        assert.equal(request.address, router);
        return vault;
      }
      if (request.functionName === "l2TokenAddress") {
        assert.equal(request.address, L2_ASSET_ROUTER_ADDRESS);
        return l2Token;
      }
      assert.equal(request.address, side === "root" ? vault : L2_NATIVE_TOKEN_VAULT_ADDRESS);
      return values[request.functionName];
    }),
  });
  const root = client("root", rootValues, 5700, 100n);
  const edge = client("edge", edgeValues, 57057, 200n);
  const context = {
    l1PublicClient: root as any,
    l1AssetRouterAddress: router as `0x${string}`,
    l1ChainId: 5700,
    l2ChainId: 57057,
  };
  const token = { address: l1Token, symbol: "UNKNOWN", decimals: 18 };
  const resolve = (official: typeof officialTokens = []) =>
    resolveSyscoinL2TokenMappings(edge as any, [token], official, context);
  return { root, edge, rootValues, edgeValues, l1Token, l2Token, originToken, assetId, calls, context, token, resolve };
}

describe("registered cross-chain NativeTokenVault mapping", () => {
  it("bounds token read fanout independently of JSON-RPC batching", async () => {
    let active = 0,
      maximum = 0;
    const client = {
      readContract: vi.fn(async () => {
        maximum = Math.max(maximum, ++active);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        active--;
        return "0x2222222222222222222222222222222222222222";
      }),
    };
    const tokens = Array.from({ length: 40 }, (_, index) => ({
      address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
      symbol: "TEST",
      decimals: 18,
    }));
    assert.equal((await resolveSyscoinL2TokenMappings(client as any, tokens)).size, 40);
    assert.equal(maximum, 8);
    const handler = readFileSync(new URL("../server/api/syscoin/token-registry.get.ts", import.meta.url), "utf8");
    assert.equal(handler.match(/batch: \{ batchSize: 32 \}/g)?.length, 2);
  });

  it("resolves arbitrary Edge-origin Root representations without the legacy prediction", async () => {
    const fixture = registeredFixture();
    const mappings = await fixture.resolve();
    assert.equal(mappings.get(fixture.l1Token)?.l2Address, fixture.l2Token);
    assert.ok(!fixture.calls.some((call) => call.functionName === "l2TokenAddress"));
    assert.ok(fixture.calls.every((call) => call.blockNumber === (call.side === "root" ? 100n : 200n)));
  });

  it("keeps curated Edge metadata while adding its discovered Root mapping after merge", async () => {
    const fixture = registeredFixture();
    const curated = {
      address: fixture.l2Token,
      l2Address: fixture.l2Token,
      symbol: "CURATED",
      decimals: 18,
      iconUrl: "/img/token.svg",
    };
    const mappings = await fixture.resolve([curated] as any);
    const mapped = mappings.get(fixture.l1Token)!;
    assert.equal(mapped.symbol, "CURATED");
    const [edge] = attachSyscoinL1MappingsToL2Tokens(mergeSyscoinTokens([curated], [{ ...curated, symbol: "WRONG" }]), [
      mapped,
    ]);
    assert.equal(edge.l1Address, fixture.l1Token);
    assert.equal(edge.iconUrl, "/img/token.svg");
  });

  it("preserves a deployed Root-origin counterpart and both first-deposit cases", async () => {
    const deployed = registeredFixture(5700n);
    assert.equal((await deployed.resolve()).get(deployed.l1Token)?.l2Address, deployed.l2Token);
    assert.ok(!deployed.calls.some((call) => call.functionName === "l2TokenAddress"));
    for (const registered of [false, true]) {
      const fixture = registeredFixture(5700n);
      if (registered) fixture.edgeValues.tokenAddress = zeroAddress;
      else fixture.rootValues.assetId = zeroHash;
      assert.equal((await fixture.resolve()).get(fixture.l1Token)?.l2Address, fixture.l2Token);
      assert.equal(fixture.calls.filter((call) => call.functionName === "l2TokenAddress").length, 1);
    }
  });

  it.each([
    ["missing Edge counterpart", "edge", "tokenAddress", zeroAddress],
    ["wrong Root reverse address", "root", "tokenAddress", zeroAddress],
    ["wrong Edge reverse asset", "edge", "assetId", zeroHash],
    ["wrong Edge origin chain", "edge", "originChainId", 5700n],
    ["wrong Edge origin token", "edge", "originToken", zeroAddress],
    ["invalid Root asset encoding", "root", "assetId", `0x${"aa".repeat(32)}`],
  ])("does not turn %s into a legacy mapping", async (_name, side, field, value) => {
    const fixture = registeredFixture();
    (side === "root" ? fixture.rootValues : fixture.edgeValues)[field as string] = value;
    assert.equal((await fixture.resolve()).size, 0);
    assert.ok(!fixture.calls.some((call) => call.functionName === "l2TokenAddress"));
  });

  it("does not fall back after an unavailable registered read or undeployed Edge token", async () => {
    const unavailable = registeredFixture();
    unavailable.root.readContract.mockRejectedValueOnce(new Error("RPC unavailable"));
    await assert.rejects(unavailable.resolve(), /RPC unavailable/);
    const perToken = registeredFixture();
    const actualRead = perToken.root.readContract.getMockImplementation()!;
    perToken.root.readContract.mockImplementation(async (request) => {
      if (request.functionName === "assetId") throw new Error("RPC unavailable");
      return actualRead(request);
    });
    assert.equal((await perToken.resolve()).size, 0);
    assert.ok(!perToken.calls.some((call) => call.functionName === "l2TokenAddress"));
    const missingCode = registeredFixture();
    missingCode.edge.getCode.mockImplementation(async (request) =>
      request.address === L2_NATIVE_TOKEN_VAULT_ADDRESS ? "0x6000" : "0x"
    );
    assert.equal((await missingCode.resolve()).size, 0);
  });

  it.each([false, true])(
    "does not predict an unregistered token when Root code is missing or unreadable (%s)",
    async (unreadable) => {
      const fixture = registeredFixture(5700n);
      fixture.rootValues.assetId = zeroHash;
      fixture.root.getCode.mockImplementation(async (request) => {
        if (request.address === fixture.l1Token) {
          if (unreadable) throw new Error("RPC unavailable");
          return "0x";
        }
        return "0x6000";
      });
      assert.equal((await fixture.resolve()).size, 0);
      assert.ok(!fixture.calls.some((call) => call.functionName === "l2TokenAddress"));
    }
  );

  it("rejects wrong configured chains and missing vault code before mapping", async () => {
    const wrongChain = registeredFixture();
    wrongChain.edge.getChainId.mockResolvedValue(1);
    await assert.rejects(wrongChain.resolve(), /Unexpected Syscoin token registry chain/);
    const noVault = registeredFixture();
    noVault.root.getCode.mockResolvedValue("0x");
    await assert.rejects(noVault.resolve(), /Missing Syscoin native token vault code/);
  });
});

describe("syscoin Blockscout mapping", () => {
  beforeEach(() => {
    fetchMock.mockClear();
  });

  it("keeps custom bridge token addresses valid for viem", () => {
    for (const token of customBridgeTokens) {
      assert.doesNotThrow(() => getAddress(token.l1Address));
      assert.doesNotThrow(() => getAddress(token.l2Address));
    }
  });

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

  it("does not request Blockscout balances without a valid account address", async () => {
    const balances = await fetchSyscoinBlockscoutTokenBalances(
      "https://explorer.tanenbaum.io/api/v2",
      "undefined",
      "L1"
    );

    assert.deepEqual(balances, []);
    assert.equal(fetchMock.mock.calls.length, 0);
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

  it("keeps the native TSYS token in the L1 registry source", () => {
    const [nativeToken] = mergeSyscoinTokens(
      [
        {
          address: "0x0000000000000000000000000000000000000000",
          l1Address: "0x0000000000000000000000000000000000000000",
          l2Address: "0x000000000000000000000000000000000000800A",
          symbol: "TSYS",
          name: "Tanenbaum Syscoin",
          decimals: 18,
          iconUrl: "/img/syscoin-icon.svg",
        },
      ],
      []
    );

    assert.equal(nativeToken.symbol, "TSYS");
    assert.equal(nativeToken.address, "0x0000000000000000000000000000000000000000");
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

  it("applies official L2 metadata to future L1 wrappers", async () => {
    const l1ZksysWrapper = "0x1111111111111111111111111111111111111111";
    const l2Zksys = "0x6EBb170f69D886916D9ee9E585CE39E626CbC35d";
    const publicClient = {
      readContract: async () => l2Zksys,
    };

    const mappings = await resolveSyscoinL2TokenMappings(
      publicClient as any,
      [
        {
          address: l1ZksysWrapper,
          symbol: "UNKNOWN",
          decimals: 18,
        },
      ],
      syscoinTanenbaumTokens
    );
    const mappedToken = mappings.get(l1ZksysWrapper.toLowerCase());

    assert.equal(mappedToken?.l1Address, l1ZksysWrapper);
    assert.equal(mappedToken?.l2Address, l2Zksys);
    assert.equal(mappedToken?.symbol, "ZKSYS");
    assert.equal(mappedToken?.iconUrl, "/img/zksys-icon.svg");
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

  it("keeps canonical zkSYS in the official L2 token set", () => {
    const zksysToken = syscoinTanenbaumTokens.find((token) => token.symbol === "ZKSYS");

    assert.equal(zksysToken?.address, "0x6EBb170f69D886916D9ee9E585CE39E626CbC35d");
    assert.equal(zksysToken?.l1Address, undefined);
    assert.equal(zksysToken?.l2Address, "0x6EBb170f69D886916D9ee9E585CE39E626CbC35d");
    assert.equal(zksysToken?.iconUrl, "/img/zksys-icon.svg");
  });

  it("uses the local USDC icon only for the accepted v32 token pair", () => {
    const l1Address = "0xB26B0EC48ed88347ed89874411cAE4A1EcdF97fd";
    const l2Address = "0xd501e86b1fc5823403b2ba995e2b8b78179236a6";
    for (const [side, address] of [
      ["L1", l1Address],
      ["L2", l2Address],
    ] as const) {
      const token = mapSyscoinBlockscoutToken(
        { address: address.toLowerCase(), symbol: "UNKNOWN", decimals: "18", icon_url: null },
        side,
        syscoinTanenbaumTokens
      );
      assert.equal(token.iconUrl, "/img/usdc-icon.svg");
      assert.equal(token.symbol, "USDC");
      assert.equal(token.decimals, 6);
      assert.equal(token.l1Address?.toLowerCase(), l1Address.toLowerCase());
      assert.equal(token.l2Address?.toLowerCase(), l2Address.toLowerCase());
    }
    const unknown = mapSyscoinBlockscoutToken(
      { address: "0x5555555555555555555555555555555555555555", symbol: "USDC", icon_url: null },
      "L2",
      syscoinTanenbaumTokens
    );
    assert.equal(unknown.iconUrl, undefined);
    assert.equal(unknown.l1Address, undefined);
  });

  it("preserves the accepted USDC mapping and icon without explorer metadata", async () => {
    const token = syscoinTanenbaumTokens.find((token) => token.symbol === "USDC")!;
    const publicClient = { readContract: vi.fn() };
    const mappings = await resolveSyscoinL2TokenMappings(
      publicClient as any,
      [{ address: token.l1Address!, symbol: "USDC", decimals: 6 }],
      syscoinTanenbaumTokens
    );
    const mapped = mappings.get(token.l1Address!.toLowerCase())!;
    assert.equal(mapped.l2Address, getAddress(token.l2Address!));
    assert.equal(mapped.iconUrl, "/img/usdc-icon.svg");
    assert.equal(publicClient.readContract.mock.calls.length, 0);
    const [l2] = attachSyscoinL1MappingsToL2Tokens(
      [mapSyscoinBlockscoutToken({ address: token.address, symbol: "USDC" }, "L2", syscoinTanenbaumTokens)],
      [mapped]
    );
    assert.equal(l2.l1Address, getAddress(token.l1Address!));
    assert.equal(l2.iconUrl, "/img/usdc-icon.svg");
  });

  it("bundles the same approved USDC artwork without an external image request", () => {
    const svg = readFileSync(new URL("../public/img/usdc-icon.svg", import.meta.url), "utf8");
    const embedded = /href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(svg);
    assert.ok(embedded);
    assert.equal(
      createHash("sha256").update(Buffer.from(embedded[1], "base64")).digest("hex"),
      "7f9969d11eef1e08ded67abd495a65b4394bf8363515eaf5bbad4c089b98928b"
    );
    assert.doesNotMatch(svg, /(?:href=["']https?:\/\/|<script\b|onload\s*=)/i);
  });
});
