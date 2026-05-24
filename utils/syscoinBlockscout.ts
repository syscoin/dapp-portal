import { $fetch } from "ofetch";
import { getAddress, isAddressEqual, zeroAddress } from "viem";

import { L2_ASSET_ROUTER_ADDRESS } from "./constants";
import { SYSCOIN_L2_ASSET_ROUTER_ABI } from "./syscoinBridge";

import type { Token, TokenAmount } from "@/types";
import type { PublicClient } from "viem";

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

const fetchBlockscoutCollection = async <T>(apiUrl: string, path: string, maxPages = 5) => {
  const items: T[] = [];
  let nextPageParams: BlockscoutCollection<T>["next_page_params"] = {};

  for (let page = 0; page < maxPages && nextPageParams !== null; page++) {
    const url = new URL(`${normalizeApiUrl(apiUrl)}${path}`);
    if (!url.searchParams.has("type")) {
      url.searchParams.set("type", "ERC-20");
    }
    for (const [key, value] of Object.entries(nextPageParams ?? {})) {
      if (value != null) url.searchParams.set(key, String(value));
    }

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
  const balances = await fetchBlockscoutCollection<BlockscoutTokenBalance>(
    apiUrl,
    `/addresses/${accountAddress}/tokens?type=ERC-20`
  );
  return balances.map((balance) => mapSyscoinBlockscoutTokenBalance(balance, side, officialTokens));
};

export const fetchSyscoinTokenRegistry = async () => {
  return await $fetch<SyscoinTokenRegistry>("/api/syscoin/token-registry");
};

export const resolveSyscoinL2TokenMappings = async (
  publicClient: PublicClient,
  l1Tokens: Token[],
  officialTokens: Token[] = []
) => {
  const mappings = new Map<string, Token>();

  await Promise.all(
    l1Tokens.map(async (l1Token) => {
      const l1Address = getAddress(l1Token.l1Address || l1Token.address);
      if (isAddressEqual(l1Address, zeroAddress)) return;

      const officialToken = matchingOfficialToken(l1Address, "L1", officialTokens);
      const l2Address = officialToken?.l2Address
        ? officialToken.l2Address
        : await publicClient
            .readContract({
              address: L2_ASSET_ROUTER_ADDRESS,
              abi: SYSCOIN_L2_ASSET_ROUTER_ABI,
              functionName: "l2TokenAddress",
              args: [l1Address],
            })
            .catch(() => undefined);

      if (!l2Address || isAddressEqual(getAddress(l2Address), zeroAddress)) return;

      mappings.set(l1Address.toLowerCase(), {
        ...l1Token,
        l1Address,
        l2Address: getAddress(l2Address),
      });
    })
  );

  return mappings;
};

export const attachSyscoinL2MappingsToL1Tokens = async (
  publicClient: PublicClient,
  l1Tokens: Token[],
  officialTokens: Token[] = []
) => {
  const mappings = await resolveSyscoinL2TokenMappings(publicClient, l1Tokens, officialTokens);

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
