import { $fetch } from "ofetch";
import { getAddress, type Address, type Hex } from "viem";

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

export type ZkSysContractLog = {
  data: Hex;
  topics: [Hex, ...Hex[]];
  blockNumber: bigint;
  timestampMs?: number;
};

const LOG_PAGES_LIMIT = 10; // 50 logs per Blockscout page

// SYSCOIN: Blockscout v2 logs endpoint, newest first. Mirrors the pagination
// handling in utils/syscoinBlockscout.ts but without the ERC-20 type param.
export const fetchZkSysContractLogs = async (apiUrl: string, address: Address, maxPages = LOG_PAGES_LIMIT) => {
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
    .map<ZkSysContractLog>((item) => ({
      data: item.data,
      topics: item.topics.filter((topic): topic is Hex => !!topic) as [Hex, ...Hex[]],
      blockNumber: BigInt(item.block_number),
      timestampMs: item.block_timestamp ? new Date(item.block_timestamp).getTime() : undefined,
    }));
};
