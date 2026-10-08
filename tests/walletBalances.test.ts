import { createPinia, defineStore, setActivePinia, storeToRefs } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, effectScope, ref } from "vue";

import usePromise from "../composables/usePromise";

const mocks = vi.hoisted(() => ({ registry: vi.fn(), balances: vi.fn(), getBalance: vi.fn() }));
vi.mock("../utils/syscoinBlockscout", () => ({
  fetchSyscoinTokenRegistry: mocks.registry,
  fetchSyscoinBlockscoutTokenBalances: mocks.balances,
}));
vi.mock("../utils/syscoinBridge", () => ({ isSyscoinBridgeNetwork: () => true }));
vi.mock("../utils/helpers", () => ({
  AddressChainType: { L2: "L2" },
  getBalancesWithCustomBridgeTokens: (value: unknown) => value,
}));
vi.mock("../composables/useSentryLogger", () => ({ useSentryLogger: () => ({ captureException: vi.fn() }) }));

const native = { address: "0x000000000000000000000000000000000000800a", symbol: "TSYS", decimals: 18 };
const good = { address: "0x1111111111111111111111111111111111111111", symbol: "GOOD", decimals: 18 };
const broken = { address: "0x2222222222222222222222222222222222222222", symbol: "BROKEN", decimals: 18 };
let useWallet: typeof import("../store/zksync/wallet").useZkSyncWalletStore;
let scope: ReturnType<typeof effectScope>;

beforeAll(async () => {
  vi.stubGlobal("defineStore", defineStore);
  ({ useZkSyncWalletStore: useWallet } = await import("../store/zksync/wallet"));
});
beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
  scope = effectScope();
  vi.stubGlobal("ref", ref);
  vi.stubGlobal("computed", computed);
  vi.stubGlobal("storeToRefs", storeToRefs);
  vi.stubGlobal("usePromise", usePromise);
  vi.stubGlobal("formatError", (error: Error) => error);
  vi.stubGlobal("L2_BASE_TOKEN_ADDRESS", native.address);
  vi.stubGlobal("useScreening", () => ({ validateAddress: async () => {} }));
  vi.stubGlobal(
    "useOnboardStore",
    defineStore("balancesOnboard", () => ({
      account: ref({ address: good.address, chain: { id: 57057 } }),
      subscribeOnAccountChange: () => () => {},
    }))
  );
  vi.stubGlobal(
    "useZkSyncProviderStore",
    defineStore("balancesProvider", () => ({
      eraNetwork: ref({ id: 57057, syscoinBridge: { l2BlockscoutApiUrl: "https://example.invalid" } }),
      requestProvider: () => Promise.resolve({ getBalance: mocks.getBalance }),
    }))
  );
  vi.stubGlobal(
    "useZkSyncTokensStore",
    defineStore("balancesTokens", () => ({
      baseToken: ref(native),
      tokens: ref(Object.fromEntries([native, good, broken].map((token) => [token.address, token]))),
      requestTokens: async () => {},
    }))
  );
  mocks.registry.mockResolvedValue({ l2Tokens: [native, good, broken] });
  mocks.balances.mockResolvedValue([
    { ...broken, amount: "99" },
    { ...good, amount: "1" },
  ]);
  mocks.getBalance.mockImplementation((_account, _block, token) => {
    if (token === broken.address) return Promise.reject(new Error("balanceOf reverted"));
    return Promise.resolve(token ? 200n : 100n);
  });
});
afterEach(() => {
  scope.stop();
});

describe("optional registry token balance failures", () => {
  it("preserves native and good RPC balances and the failed token's explorer value", async () => {
    const wallet = scope.run(() => useWallet())!;
    await wallet.requestBalance();
    expect(wallet.balanceError).toBeUndefined();
    expect(wallet.balance.find((token) => token.address === native.address)?.amount).toBe("100");
    expect(wallet.balance.find((token) => token.address === good.address)?.amount).toBe("200");
    expect(wallet.balance.find((token) => token.address === broken.address)?.amount).toBe("99");
  });

  it("still lets a successful RPC read override stale explorer balances", async () => {
    mocks.getBalance.mockResolvedValue(300n);
    const wallet = scope.run(() => useWallet())!;
    await wallet.requestBalance();
    expect(wallet.balance.find((token) => token.address === broken.address)?.amount).toBe("300");
    expect(wallet.balanceError).toBeUndefined();
  });
});
