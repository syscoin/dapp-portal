import { $fetch } from "ofetch";
import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  zeroAddress,
  zeroHash,
} from "viem";

import { L2_ASSET_ROUTER_ADDRESS, L2_NATIVE_TOKEN_VAULT_ADDRESS } from "./constants";
import { SYSCOIN_L1_ASSET_ROUTER_ABI, SYSCOIN_L2_ASSET_ROUTER_ABI } from "./syscoinBridge";

import type { Token, TokenAmount } from "@/types";
import type { PublicClient } from "viem";

const NATIVE_TOKEN_MAPPING_ABI = parseAbi([
  "function assetId(address token) view returns (bytes32)",
  "function tokenAddress(bytes32 assetId) view returns (address)",
  "function originChainId(bytes32 assetId) view returns (uint256)",
  "function originToken(bytes32 assetId) view returns (address)",
]);

export type SyscoinRegisteredMappingContext = {
  l1PublicClient: PublicClient;
  l1AssetRouterAddress: `0x${string}`;
  l1ChainId: number;
  l2ChainId: number;
};

// Bind both clients to the configured chains and use one block per chain. A
// failed identity/read check must not silently become a legacy address guess.
const prepareRegisteredMappings = async (l2PublicClient: PublicClient, context: SyscoinRegisteredMappingContext) => {
  const [l1ChainId, l2ChainId, l1Block, l2Block] = await Promise.all([
    context.l1PublicClient.getChainId(),
    l2PublicClient.getChainId(),
    context.l1PublicClient.getBlockNumber(),
    l2PublicClient.getBlockNumber(),
  ]);
  if (l1ChainId !== context.l1ChainId || l2ChainId !== context.l2ChainId) {
    throw new Error("Unexpected Syscoin token registry chain");
  }
  const l1Vault = await context.l1PublicClient.readContract({
    address: context.l1AssetRouterAddress,
    abi: SYSCOIN_L1_ASSET_ROUTER_ABI,
    functionName: "nativeTokenVault",
    blockNumber: l1Block,
  });
  if (isAddressEqual(l1Vault, zeroAddress)) throw new Error("Missing Syscoin native token vault");
  const codes = await Promise.all([
    context.l1PublicClient.getCode({ address: l1Vault, blockNumber: l1Block }),
    l2PublicClient.getCode({ address: L2_NATIVE_TOKEN_VAULT_ADDRESS, blockNumber: l2Block }),
  ]);
  if (codes.some((code) => !code || code === "0x")) throw new Error("Missing Syscoin native token vault code");

  const l1Read = (functionName: "assetId" | "tokenAddress" | "originChainId" | "originToken", args: [`0x${string}`]) =>
    context.l1PublicClient.readContract({
      address: l1Vault,
      abi: NATIVE_TOKEN_MAPPING_ABI,
      functionName,
      args,
      blockNumber: l1Block,
    });
  const l2Read = (functionName: "assetId" | "tokenAddress" | "originChainId" | "originToken", args: [`0x${string}`]) =>
    l2PublicClient.readContract({
      address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
      abi: NATIVE_TOKEN_MAPPING_ABI,
      functionName,
      args,
      blockNumber: l2Block,
    });
  const legacyAddress = (l1Token: `0x${string}`) =>
    l2PublicClient.readContract({
      address: L2_ASSET_ROUTER_ADDRESS,
      abi: SYSCOIN_L2_ASSET_ROUTER_ABI,
      functionName: "l2TokenAddress",
      args: [l1Token],
      blockNumber: l2Block,
    });

  return async (l1Token: `0x${string}`): Promise<`0x${string}` | undefined> => {
    const assetId = await l1Read("assetId", [l1Token]);
    // Unregistered Root-native tokens retain the existing first-deposit path.
    if (assetId === zeroHash) {
      // An indexer can be ahead of this RPC snapshot. An address with no code
      // here is not evidence of an unregistered Root-native ERC20.
      const code = await context.l1PublicClient.getCode({ address: l1Token, blockNumber: l1Block });
      return code && code !== "0x" ? legacyAddress(l1Token) : undefined;
    }
    const [rootToken, originChainId, originToken, l2Token] = await Promise.all([
      l1Read("tokenAddress", [assetId as `0x${string}`]),
      l1Read("originChainId", [assetId as `0x${string}`]),
      l1Read("originToken", [assetId as `0x${string}`]),
      l2Read("tokenAddress", [assetId as `0x${string}`]),
    ]);
    if (
      typeof originChainId !== "bigint" ||
      originChainId <= 0n ||
      !isAddressEqual(rootToken as `0x${string}`, l1Token) ||
      isAddressEqual(originToken as `0x${string}`, zeroAddress)
    )
      return;
    const expectedAssetId = keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "address" }],
        [originChainId, L2_NATIVE_TOKEN_VAULT_ADDRESS, originToken as `0x${string}`]
      )
    );
    if (assetId !== expectedAssetId) return;
    if (originChainId === BigInt(l1ChainId) && !isAddressEqual(originToken as `0x${string}`, l1Token)) return;
    if (isAddressEqual(l2Token as `0x${string}`, zeroAddress)) {
      // Only a proven Root-origin asset may use an undeployed first-deposit address.
      return originChainId === BigInt(l1ChainId) ? legacyAddress(l1Token) : undefined;
    }
    const [reverseId, edgeOriginChainId, edgeOriginToken, code] = await Promise.all([
      l2Read("assetId", [l2Token as `0x${string}`]),
      l2Read("originChainId", [assetId as `0x${string}`]),
      l2Read("originToken", [assetId as `0x${string}`]),
      l2PublicClient.getCode({ address: l2Token as `0x${string}`, blockNumber: l2Block }),
    ]);
    if (
      reverseId !== assetId ||
      edgeOriginChainId !== originChainId ||
      !isAddressEqual(edgeOriginToken as `0x${string}`, originToken as `0x${string}`) ||
      !code ||
      code === "0x" ||
      (originChainId === BigInt(l2ChainId) && !isAddressEqual(originToken as `0x${string}`, l2Token as `0x${string}`))
    )
      return;
    return getAddress(l2Token as `0x${string}`);
  };
};

type BlockscoutToken = {
  address?: string;
  address_hash?: string;
  decimals?: string | number | null;
  exchange_rate?: string | number | null;
  icon_url?: string | null;
  name?: string | null;
  symbol?: string | null;
  type?: string | null;
};

type BlockscoutTokenBalance = {
  token: BlockscoutToken;
  value: string;
};

type BlockscoutCollection<T> = {
  items: T[];
  next_page_params?: Record<string, string | number | boolean | null> | null;
};

type SyscoinTokenSide = "L1" | "L2";
export type SyscoinTokenRegistry = {
  updatedAt: string;
  l1Tokens: Token[];
  l2Tokens: Token[];
};

const normalizeApiUrl = (apiUrl: string) => apiUrl.replace(/\/$/, "");

const tokenAddress = (token: BlockscoutToken) => getAddress(token.address_hash || token.address || zeroAddress);

const tokenDecimals = (token: BlockscoutToken) => {
  const decimals = Number(token.decimals ?? 18);
  return Number.isFinite(decimals) ? decimals : 18;
};

const tokenPrice = (token: BlockscoutToken) => {
  if (token.exchange_rate == null) return undefined;
  const price = Number(token.exchange_rate);
  return Number.isFinite(price) ? price : undefined;
};

const matchingOfficialToken = (address: string, side: SyscoinTokenSide, officialTokens: Token[]) => {
  return officialTokens.find((token) => {
    const officialAddress = side === "L1" ? token.l1Address : token.l2Address || token.address;
    return !!officialAddress && isAddressEqual(getAddress(officialAddress), getAddress(address));
  });
};

export const mapSyscoinBlockscoutToken = (
  token: BlockscoutToken,
  side: SyscoinTokenSide,
  officialTokens: Token[] = []
): Token => {
  const address = tokenAddress(token);
  const officialToken = matchingOfficialToken(address, side, officialTokens);

  return {
    address,
    l1Address: side === "L1" ? address : officialToken?.l1Address,
    l2Address: side === "L2" ? address : officialToken?.l2Address,
    name: officialToken?.name || token.name || undefined,
    symbol: officialToken?.symbol || token.symbol || "UNKNOWN",
    decimals: officialToken?.decimals ?? tokenDecimals(token),
    iconUrl: officialToken?.iconUrl || token.icon_url || undefined,
    price: officialToken?.price ?? tokenPrice(token),
    isETH: officialToken?.isETH || isAddressEqual(address, zeroAddress),
    l1BridgeAddress: officialToken?.l1BridgeAddress,
    l2BridgeAddress: officialToken?.l2BridgeAddress,
  };
};

export const mapSyscoinBlockscoutTokenBalance = (
  item: BlockscoutTokenBalance,
  side: SyscoinTokenSide,
  officialTokens: Token[] = []
): TokenAmount => {
  return {
    ...mapSyscoinBlockscoutToken(item.token, side, officialTokens),
    amount: item.value,
  };
};

const fetchBlockscoutCollection = async <T>(apiUrl: string, path: string, maxPages = 20) => {
  const items: T[] = [];
  let nextPageParams: BlockscoutCollection<T>["next_page_params"] = {};
  const seenPageCursors = new Set<string>();

  for (let page = 0; page < maxPages && nextPageParams !== null; page++) {
    const url = new URL(`${normalizeApiUrl(apiUrl)}${path}`);
    if (!url.searchParams.has("type")) {
      url.searchParams.set("type", "ERC-20");
    }
    for (const [key, value] of Object.entries(nextPageParams ?? {})) {
      // SYSCOIN: Blockscout v2 pagination expects null cursor fields to be
      // present as empty query params. Dropping them causes repeated pages.
      url.searchParams.set(key, value == null ? "" : String(value));
    }

    const cursor = url.searchParams.toString();
    if (seenPageCursors.has(cursor)) break;
    seenPageCursors.add(cursor);

    const response = await $fetch<BlockscoutCollection<T>>(url.toString());
    items.push(...response.items);
    nextPageParams = response.next_page_params ?? null;
  }

  return items;
};

export const fetchSyscoinBlockscoutTokens = async (
  apiUrl: string,
  side: SyscoinTokenSide,
  officialTokens: Token[] = []
) => {
  const tokens = await fetchBlockscoutCollection<BlockscoutToken>(apiUrl, "/tokens?type=ERC-20");
  return tokens.map((token) => mapSyscoinBlockscoutToken(token, side, officialTokens));
};

export const fetchSyscoinBlockscoutTokenBalances = async (
  apiUrl: string,
  accountAddress: string,
  side: SyscoinTokenSide,
  officialTokens: Token[] = []
) => {
  // SYSCOIN: wallet hydration can briefly expose an undefined address while
  // balance views are mounting; never turn that into a Blockscout request.
  if (!isAddress(accountAddress)) return [];

  const balances = await fetchBlockscoutCollection<BlockscoutTokenBalance>(
    apiUrl,
    `/addresses/${getAddress(accountAddress)}/tokens?type=ERC-20`
  );
  return balances.map((balance) => mapSyscoinBlockscoutTokenBalance(balance, side, officialTokens));
};

export const fetchSyscoinTokenRegistry = async () => {
  return await $fetch<SyscoinTokenRegistry>("/api/syscoin/token-registry");
};

export const resolveSyscoinL2TokenMappings = async (
  publicClient: PublicClient,
  l1Tokens: Token[],
  officialTokens: Token[] = [],
  registeredContext?: SyscoinRegisteredMappingContext
) => {
  const mappings = new Map<string, Token>();
  const registeredAddress = registeredContext
    ? await prepareRegisteredMappings(publicClient, registeredContext)
    : undefined;

  // Each token has at most four simultaneous reads. Bound token workers too:
  // batching alone limits envelope size, not the number of envelopes in flight.
  let nextToken = 0;
  const resolveToken = async (l1Token: Token) => {
    const l1Address = getAddress(l1Token.l1Address || l1Token.address);
    if (isAddressEqual(l1Address, zeroAddress)) return;

    const officialToken = matchingOfficialToken(l1Address, "L1", officialTokens);
    const l2Address = officialToken?.l2Address
      ? officialToken.l2Address
      : registeredAddress
      ? await registeredAddress(l1Address).catch(() => undefined)
      : await publicClient
          .readContract({
            address: L2_ASSET_ROUTER_ADDRESS,
            abi: SYSCOIN_L2_ASSET_ROUTER_ABI,
            functionName: "l2TokenAddress",
            args: [l1Address],
          })
          .catch(() => undefined);

    if (!l2Address || isAddressEqual(getAddress(l2Address), zeroAddress)) return;

    // SYSCOIN: an L1 wrapper can be unknown to Blockscout while its L2 token
    // is already part of the curated registry. Preserve the official L2
    // metadata when resolving future wrapper mappings.
    const officialL2Token = matchingOfficialToken(l2Address, "L2", officialTokens);
    mappings.set(l1Address.toLowerCase(), {
      ...l1Token,
      name: officialL2Token?.name || l1Token.name,
      symbol: officialL2Token?.symbol || l1Token.symbol,
      decimals: officialL2Token?.decimals ?? l1Token.decimals,
      iconUrl: officialL2Token?.iconUrl || l1Token.iconUrl,
      l1Address,
      l2Address: getAddress(l2Address),
    });
  };
  await Promise.all(
    Array.from({ length: Math.min(8, l1Tokens.length) }, async () => {
      while (nextToken < l1Tokens.length) await resolveToken(l1Tokens[nextToken++]);
    })
  );

  return mappings;
};

export const attachSyscoinL2MappingsToL1Tokens = async (
  publicClient: PublicClient,
  l1Tokens: Token[],
  officialTokens: Token[] = [],
  registeredContext?: SyscoinRegisteredMappingContext
) => {
  const mappings = await resolveSyscoinL2TokenMappings(publicClient, l1Tokens, officialTokens, registeredContext);

  return l1Tokens.map((token) => {
    const mappedToken = mappings.get(getAddress(token.address).toLowerCase());
    return mappedToken ?? token;
  });
};

export const attachSyscoinL1MappingsToL2Tokens = (l2Tokens: Token[], mappedL1Tokens: Token[]) => {
  const l2ToL1 = new Map<string, Token>();

  for (const l1Token of mappedL1Tokens) {
    if (!l1Token.l2Address) continue;
    l2ToL1.set(getAddress(l1Token.l2Address).toLowerCase(), l1Token);
  }

  return l2Tokens.map((token) => {
    const l1Token = l2ToL1.get(getAddress(token.address).toLowerCase());
    if (!l1Token) return token;

    return {
      ...token,
      l1Address: getAddress(l1Token.l1Address || l1Token.address),
      l2Address: getAddress(token.address),
      l1BridgeAddress: l1Token.l1BridgeAddress,
      l2BridgeAddress: l1Token.l2BridgeAddress,
    };
  });
};

export const mergeSyscoinTokens = (primary: Token[], secondary: Token[]) => {
  const seen = new Set<string>();
  const merged: Token[] = [];

  for (const token of [...primary, ...secondary]) {
    const address = getAddress(token.address);
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    merged.push({ ...token, address });
  }

  return merged;
};
