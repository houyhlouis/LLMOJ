import React, { useRef, useState } from "react";
import { Button, Form, Header, Input, Message, Modal } from "semantic-ui-react";

import api, { ApiResponse } from "@/api";
import { appState } from "@/appState";
import TwoFactorPrompt, { TwoFactorProof } from "@/components/TwoFactorPrompt";
import { useLocalizer } from "@/utils/hooks";
import { onEnterPress } from "@/utils/onEnterPress";
import toast from "@/utils/toast";

interface PendingConfirmation {
  twoFactor?: ApiTypes.TwoFactorChallengeDto;
  resolve: (confirmed: boolean) => void;
}

/**
 * Sensitive account changes are refused with `REAUTHENTICATION_REQUIRED` unless the password (and second factor)
 * was entered recently. `withReauthentication` asks for them in a dialog and then repeats the request once.
 */
export function useReauthentication() {
  const _ = useLocalizer("components.two_factor");
  const [confirmation, setConfirmation] = useState<PendingConfirmation>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>(null);
  const [pending, setPending] = useState(false);
  const refPassword = useRef<Input>();

  const finish = (confirmed: boolean) => {
    confirmation?.resolve(confirmed);
    setConfirmation(null);
    setPassword("");
    setError(null);
  };

  async function confirm(): Promise<boolean> {
    const { requestError, response } = await api.twoFactor.getReauthenticationOptions();
    if (requestError) toast.error(requestError(_));
    else if (response.error) toast.error(_(`.errors.${response.error}`));
    else return await new Promise<boolean>(resolve => setConfirmation({ twoFactor: response.twoFactor, resolve }));
    return false;
  }

  async function submit(proof: TwoFactorProof = {}) {
    if (pending) return;
    if (!password) {
      setError("EMPTY_PASSWORD");
      refPassword.current?.focus();
      return;
    }
    setPending(true);
    try {
      const { requestError, response } = await api.twoFactor.reauthenticate({
        password,
        challenge: confirmation.twoFactor?.token,
        ...proof
      });
      if (requestError) toast.error(requestError(_));
      else if (response.error === "CHALLENGE_EXPIRED" || response.error === "TOO_MANY_ATTEMPTS") {
        // A used-up challenge can't be answered again; start a new one.
        const next = await api.twoFactor.getReauthenticationOptions();
        if (next.response && !next.response.error)
          setConfirmation({ ...confirmation, twoFactor: next.response.twoFactor });
        setError(response.error);
      } else if (response.error) {
        setError(response.error);
        if (response.error === "WRONG_PASSWORD") refPassword.current?.focus();
      } else finish(true);
    } finally {
      setPending(false);
    }
  }

  async function withReauthentication<T extends { error?: string }>(
    send: () => Promise<Omit<ApiResponse<T>, "requestCancelled">>
  ): Promise<Omit<ApiResponse<T>, "requestCancelled">> {
    const result = await send();
    if (result.response?.error !== "REAUTHENTICATION_REQUIRED" || !(await confirm())) return result;
    return await send();
  }

  const passwordError = error === "WRONG_PASSWORD" || error === "EMPTY_PASSWORD";
  const element = (
    <Modal size="tiny" open={!!confirmation} onClose={() => !pending && finish(false)}>
      <Header icon="shield alternate" content={_(".reauthenticate.header")} />
      <Modal.Content>
        {confirmation && (
          <Form onSubmit={e => e.preventDefault()}>
            <p>{_(confirmation.twoFactor ? ".reauthenticate.message_two_factor" : ".reauthenticate.message")}</p>
            <input readOnly type="text" hidden autoComplete="username" value={appState.currentUser?.username || ""} />
            <Form.Field>
              <Input
                ref={refPassword}
                fluid
                autoFocus
                type="password"
                icon="lock"
                iconPosition="left"
                autoComplete="current-password"
                placeholder={_(".reauthenticate.password")}
                value={password}
                readOnly={pending}
                error={passwordError}
                onChange={(e, { value }) => {
                  setPassword(value);
                  setError(null);
                }}
                onKeyPress={onEnterPress(() => !confirmation.twoFactor && submit())}
              />
            </Form.Field>
            {(passwordError || (error && !confirmation.twoFactor)) && (
              <Message error visible size="small" content={_(`.errors.${error}`)} />
            )}
            {confirmation.twoFactor && (
              <TwoFactorPrompt
                challenge={confirmation.twoFactor}
                pending={pending}
                error={passwordError ? null : error}
                onSubmit={proof => submit(proof)}
              />
            )}
          </Form>
        )}
      </Modal.Content>
      <Modal.Actions>
        <Button type="button" disabled={pending} content={_(".reauthenticate.cancel")} onClick={() => finish(false)} />
        {!confirmation?.twoFactor && (
          <Button
            type="button"
            primary
            loading={pending}
            content={_(".reauthenticate.confirm")}
            onClick={() => submit()}
          />
        )}
      </Modal.Actions>
    </Modal>
  );

  return { element, withReauthentication };
}
