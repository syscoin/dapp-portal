import { useSentryLogger } from "./useSentryLogger";

const defaultOptions: {
  cache?: number | boolean;
} = {
  cache: true,
};
type UsePromiseOptions = typeof defaultOptions;

const defaultExecuteOptions: {
  force?: boolean;
} = {
  force: false,
};
type UsePromiseExecuteOptions = typeof defaultExecuteOptions;

export default <ResultType, ErrorType = Error>(fn: () => Promise<ResultType>, options?: UsePromiseOptions) => {
  const opts = Object.assign({}, defaultExecuteOptions, options);

  let promise: Promise<ResultType> | undefined;
  // SYSCOIN: resets/account changes invalidate every pending state publication.
  let generation = 0;
  const result = ref<ResultType | undefined>();
  const inProgress = ref(false);
  const error = ref<ErrorType | undefined>();
  let removeCacheTimeout: ReturnType<typeof setTimeout> | undefined;
  const removeCacheTimeoutClear = () => {
    clearTimeout(removeCacheTimeout);
    removeCacheTimeout = undefined;
  };
  const { captureException } = useSentryLogger();

  const execute = async (options?: UsePromiseExecuteOptions): Promise<ResultType | undefined> => {
    const { force } = Object.assign({}, defaultExecuteOptions, options);
    if (!promise || force) {
      generation++;
      promise = fn();
      removeCacheTimeoutClear();
      inProgress.value = true;
      error.value = undefined;
    }
    const requestGeneration = generation;
    const requestPromise = promise;

    let rawResult: ResultType | undefined;
    try {
      rawResult = await requestPromise;
      if (requestGeneration === generation) result.value = rawResult;
    } catch (e) {
      // SYSCOIN: filtered wallet rejections must still evict the current promise.
      if (requestGeneration === generation) promise = undefined;
      const err = formatError(e as Error);
      if (!err) return;

      if (requestGeneration === generation) {
        error.value = err as unknown as ErrorType;
        captureException({
          error: err,
          parentFunctionName: "execute",
          parentFunctionParams: [options],
          filePath: "composables/usePromise.ts",
        });
      }
      throw err;
    } finally {
      if (requestGeneration === generation) {
        inProgress.value = false;
        if (opts.cache === false) {
          promise = undefined;
        } else if (typeof opts.cache === "number") {
          if (!removeCacheTimeout) {
            removeCacheTimeout = setTimeout(() => {
              if (requestGeneration !== generation) return;
              promise = undefined;
              removeCacheTimeoutClear();
            }, opts.cache);
          }
        }
      }
    }
    return rawResult;
  };

  const reset = () => {
    generation++;
    promise = undefined;
    error.value = undefined;
    result.value = undefined;
    inProgress.value = false;
    removeCacheTimeoutClear();
  };

  // Reloads the promise if it is already in progress or has already been executed
  const reload = async () => {
    if (promise || inProgress.value || error.value || result.value) {
      reset();
      await execute({ force: true });
    }
  };

  return {
    error,
    result,
    inProgress,
    execute,
    reset,
    reload,
  };
};
