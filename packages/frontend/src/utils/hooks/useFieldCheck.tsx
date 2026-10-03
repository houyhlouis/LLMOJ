import React, { useState, useRef } from "react";
import { useDebouncedCallback } from "use-debounce";

export function useFieldCheck(
  fieldValue: string,
  alwaysCheck: boolean,
  debounce: number | false,
  syncCheck?: (fieldValue: string) => boolean | string,
  asyncCheck?: (fieldValue: string) => Promise<boolean | string>
): [
  (forceCheck?: boolean) => Promise<void>,
  (forceRecheck?: boolean) => Promise<boolean>,
  () => "" | "error" | "success" | "warning" | "validating",
  () => React.ReactNode,
  () => string
] {
  const [fieldChecking, setFieldChecking] = useState(false);
  const [fieldCheckStatus, setFieldCheckStatus] = useState<string | boolean>(false);
  const fieldValueLastCheckedRef = useRef<string>(null);
  const checkingPromiseRef = useRef<Promise<void>>(null);

  const fieldValueRef = useRef<string>();
  fieldValueRef.current = fieldValue;

  const fieldCheckStatusRef = useRef<boolean | string>(false);
  const validatorsRef = useRef({ syncCheck, asyncCheck });
  validatorsRef.current = { syncCheck, asyncCheck };

  async function checkField(forceCheck?: boolean) {
    // Blur and submit can request validation in the same render. Share the
    // in-flight promise so every caller waits for the same completed result.
    if (checkingPromiseRef.current) {
      await checkingPromiseRef.current;
      // A dependent field may have changed without changing this field's value.
      // Forced/always-on checks must use the latest validators after waiting.
      if (alwaysCheck || forceCheck || fieldValueLastCheckedRef.current !== fieldValueRef.current) {
        return checkField(forceCheck);
      }
      return;
    }
    if (fieldValueLastCheckedRef.current === fieldValueRef.current && !alwaysCheck && !forceCheck) return;

    setFieldChecking(true);

    async function check(value: string): Promise<string | boolean> {
      const { syncCheck: currentSyncCheck, asyncCheck: currentAsyncCheck } = validatorsRef.current;
      const syncCheckResult = !currentSyncCheck || currentSyncCheck(value);
      if (syncCheckResult !== true) return syncCheckResult;

      setFieldCheckStatus(false); // Remove error message
      const asyncCheckResult = !currentAsyncCheck || (await currentAsyncCheck(value));
      if (asyncCheckResult !== true) return asyncCheckResult;

      return true;
    }

    const checkingPromise = (async () => {
      // Check again if the user changes the value during asynchronous validation.
      while (true) {
        const checkedValue = fieldValueRef.current;
        const status = await check(checkedValue);
        if (fieldValueRef.current === checkedValue) {
          // Publish before resolving: React may batch the visual state update
          // with the submit handler that is waiting for this check.
          fieldCheckStatusRef.current = status;
          fieldValueLastCheckedRef.current = checkedValue;
          setFieldCheckStatus(status);
          return;
        }
      }
    })().finally(() => {
      checkingPromiseRef.current = null;
      setFieldChecking(false);
    });
    checkingPromiseRef.current = checkingPromise;
    return checkingPromise;
  }

  const debouncedCheckField = useDebouncedCallback(checkField, debounce || 1);

  // If NOT checked, start a check and wait for it
  // If already checked, return immediately
  // If checking, wait for it
  // Return if the value passed validation
  // Used when the being checked value if required
  async function waitForCheck(forceRecheck?: boolean): Promise<boolean> {
    await checkField(forceRecheck);

    return fieldCheckStatusRef.current === true;
  }

  function getUIValidateStatus() {
    if (fieldChecking) return "validating";
    else if (typeof fieldCheckStatus === "string") return "error";
    else if (fieldCheckStatus === true) return "success";
    else return "";
  }

  function getUIHelp() {
    if (typeof fieldCheckStatus === "string") {
      if (fieldCheckStatus.indexOf("\n") !== -1) return <div style={{ marginBottom: 6 }}>{fieldCheckStatus}</div>;
      else return fieldCheckStatus;
    }
    return null;
  }

  function getCurrentValue() {
    return fieldValueRef.current;
  }

  // FIXME: debouncedCheckField won't return a promise
  return [
    debounce ? async () => void debouncedCheckField() : checkField,
    waitForCheck,
    getUIValidateStatus,
    getUIHelp,
    getCurrentValue
  ];
}
