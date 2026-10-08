import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

import usePromise from "../composables/usePromise";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("../composables/useSentryLogger", () => ({ useSentryLogger: () => ({ captureException }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

describe("usePromise request isolation", () => {
  beforeEach(() => {
    vi.stubGlobal("ref", ref);
    vi.stubGlobal("formatError", (error: Error) => error);
    vi.useFakeTimers();
    captureException.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not publish an old account's result after reset", async () => {
    const old = deferred<string>();
    const current = deferred<string>();
    const fn = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const request = usePromise<string>(fn);
    const first = request.execute();
    request.reset();
    const second = request.execute();
    current.resolve("new-account");
    await second;
    old.resolve("old-account");
    expect(await first).toBe("old-account");
    expect(request.result.value).toBe("new-account");
  });

  it("does not clear loading or cache when an old request rejects", async () => {
    const old = deferred<string>();
    const current = deferred<string>();
    const fn = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const request = usePromise<string>(fn, { cache: false });
    const first = request.execute().catch((error) => error);
    request.reset();
    const second = request.execute();
    old.reject(new Error("old failure"));
    await first;
    expect(request.inProgress.value).toBe(true);
    expect(request.error.value).toBeUndefined();
    expect(captureException).not.toHaveBeenCalled();
    const joined = request.execute();
    expect(fn).toHaveBeenCalledTimes(2);
    current.resolve("new-account");
    await Promise.all([second, joined]);
    expect(request.result.value).toBe("new-account");
  });

  it("isolates forced refreshes and their expiry timers", async () => {
    const old = deferred<string>();
    const current = deferred<string>();
    const fn = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise).mockResolvedValue("third");
    const request = usePromise<string>(fn, { cache: 100 });
    const first = request.execute();
    const second = request.execute({ force: true });
    old.resolve("old");
    await first;
    expect(request.inProgress.value).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    const joined = request.execute();
    expect(fn).toHaveBeenCalledTimes(2);
    current.resolve("current");
    await Promise.all([second, joined]);
    await vi.advanceTimersByTimeAsync(99);
    expect(await request.execute()).toBe("current");
    await vi.advanceTimersByTimeAsync(1);
    expect(await request.execute()).toBe("third");
  });

  it("keeps current errors and ordinary deduplication behavior", async () => {
    const pending = deferred<string>();
    const fn = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue("retry");
    const request = usePromise<string>(fn);
    const first = request.execute().catch((error) => error);
    const joined = request.execute().catch((error) => error);
    expect(fn).toHaveBeenCalledTimes(1);
    pending.reject(new Error("current failure"));
    await Promise.all([first, joined]);
    expect(request.error.value?.message).toBe("current failure");
    expect(request.inProgress.value).toBe(false);
    expect(await request.execute()).toBe("retry");
  });
});
