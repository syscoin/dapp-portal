export default function useTimedCache<ResultType, ParamsType extends unknown[]>(
  fn: (...args: ParamsType) => Promise<ResultType>,
  cacheTime: number
) {
  type TimedCache = ((...args: ParamsType) => Promise<ResultType>) & { clear: () => void };
  let cache:
    | {
        params: ParamsType;
        promise: Promise<ResultType>;
        timestamp: number;
      }
    | undefined;

  const execute = ((...args: ParamsType): Promise<ResultType> => {
    const now = Date.now();
    if (cache && now - cache.timestamp < cacheTime && JSON.stringify(cache.params) === JSON.stringify(args)) {
      return cache.promise;
    }

    const promise = fn(...args);
    cache = {
      params: args,
      promise,
      timestamp: now,
    };
    return promise;
  }) as TimedCache;

  execute.clear = () => {
    cache = undefined;
  };

  return execute;
}
