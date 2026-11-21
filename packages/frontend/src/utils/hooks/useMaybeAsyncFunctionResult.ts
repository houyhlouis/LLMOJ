import { useEffect, useRef, useState } from "react";
import { v4 as uuid } from "uuid";

type RemoveLast<T extends any[]> = T extends [...infer RemovedLast, any] ? RemovedLast : any[];
type Last<T extends any[]> = T extends [...any, infer Last] ? Last : any[];

/**
 * Runs `f`, which passes its result to its last argument, either at once or later (it may be async). Returns the
 * latest result, whether a run is still pending, the error of the latest run if it failed (it threw, or its promise was
 * rejected, e.g. a lazily loaded module couldn't load), and a function that runs it again. A run that fails isn't left
 * pending, and the result or error of a run that a newer one replaced is ignored.
 */
export const useMaybeAsyncFunctionResult = <F extends (...args: [...any, (result: any) => void]) => unknown>(
  f: F,
  args: RemoveLast<Parameters<F>>,
  dependencies?: any[]
) => {
  type Result = Parameters<Last<Parameters<F>>>[0];

  const refCurrentRenderingProcessId = useRef(null);

  function invoke(onResult: (result: Result) => void, onPending: () => void, onError: (error: unknown) => void) {
    const renderingProcessId = uuid();
    refCurrentRenderingProcessId.current = renderingProcessId;
    const current = () => refCurrentRenderingProcessId.current === renderingProcessId;

    let finished = false;
    const fail = (error: unknown) => {
      // A run that already gave its result keeps it
      if (finished) return;
      finished = true;
      if (current()) onError(error);
    };
    try {
      const returned = f(...args, (result: any) => {
        finished = true;
        if (current()) onResult(result);
      });
      if (returned && typeof (returned as PromiseLike<unknown>).then === "function")
        (returned as PromiseLike<unknown>).then(undefined, fail);
    } catch (error) {
      fail(error);
    }

    if (!finished) {
      // async
      onPending();
    }
  }

  // Advance first invoke to first render, not first effect run
  const refFirstInvokeResult = useRef<Result>(null);
  const refFirstInvokePending = useRef<boolean>(false);
  const refFirstInvokeError = useRef<unknown>(null);
  if (refCurrentRenderingProcessId.current == null) {
    invoke(
      r => {
        if (refFirstInvokePending.current) {
          // First invoke async
          setResult(r);
          setPending(false);
        } else {
          // First invoke sync
          refFirstInvokeResult.current = r;
        }
      },
      () => (refFirstInvokePending.current = true),
      e => {
        if (refFirstInvokePending.current) {
          setError(e);
          setPending(false);
        } else refFirstInvokeError.current = e;
      }
    );
  }
  const [result, setResult] = useState(refFirstInvokeResult.current);
  const [pending, setPending] = useState(refFirstInvokePending.current);
  const [error, setError] = useState<unknown>(refFirstInvokeError.current);

  function run() {
    invoke(
      r => {
        setResult(r);
        setError(null);
        setPending(false);
      },
      () => {
        setError(null);
        setPending(true);
      },
      e => {
        setError(e);
        setPending(false);
      }
    );
  }

  // Invocations due to dependencies change
  const refEffectFirstRun = useRef(false);
  useEffect(() => {
    if (!refEffectFirstRun.current) {
      refEffectFirstRun.current = true;
      return;
    }

    run();
  }, dependencies || args);

  return [result, pending, error, run] as const;
};
