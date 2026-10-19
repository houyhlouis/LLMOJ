import React, { useState } from "react";
import { Button, Form, Icon, Input, Message } from "semantic-ui-react";

import PseudoLink from "@/components/PseudoLink";
import { useLocalizer } from "@/utils/hooks";
import { onEnterPress } from "@/utils/onEnterPress";
import { getPasskeyAssertion, isPasskeyCancelled, isPasskeySupported } from "@/utils/webauthn";

export type TwoFactorMethod = "totp" | "passkey" | "recoveryCode";

/** Exactly one second factor. */
export interface TwoFactorProof {
  totpCode?: string;
  recoveryCode?: string;
  passkey?: ApiTypes.PasskeyAssertionDto;
}

interface TwoFactorPromptProps {
  challenge: ApiTypes.TwoFactorChallengeDto;
  pending: boolean;
  /** An error code from the last attempt, shown under the input. */
  error?: string;
  onSubmit: (proof: TwoFactorProof) => void;
}

export function defaultTwoFactorMethod(methods: TwoFactorMethod[]): TwoFactorMethod {
  if (methods.includes("passkey") && isPasskeySupported()) return "passkey";
  return methods.includes("totp") ? "totp" : methods[0];
}

/** The second sign-in step: an authenticator code, a passkey or a recovery code. */
const TwoFactorPrompt: React.FC<TwoFactorPromptProps> = props => {
  const _ = useLocalizer("components.two_factor");
  const methods = props.challenge.methods;
  const [method, setMethod] = useState<TwoFactorMethod>(() => defaultTwoFactorMethod(methods));
  const [code, setCode] = useState("");
  const [passkeyError, setPasskeyError] = useState<string>(null);

  const switchTo = (next: TwoFactorMethod) => {
    setMethod(next);
    setCode("");
    setPasskeyError(null);
  };

  const submitCode = (value = code) => {
    if (props.pending || !value) return;
    props.onSubmit(method === "totp" ? { totpCode: value } : { recoveryCode: value.trim() });
  };

  async function confirmWithPasskey() {
    if (props.pending) return;
    setPasskeyError(null);
    try {
      props.onSubmit({ passkey: await getPasskeyAssertion(props.challenge.passkey) });
    } catch (e) {
      setPasskeyError(
        isPasskeyCancelled(e) ? _(".prompt.passkey_cancelled") : _(".prompt.passkey_failed", { message: e.message })
      );
    }
  }

  const error = passkeyError || (props.error && _(`.errors.${props.error}`));
  const passkeyUsable = isPasskeySupported();
  return (
    <>
      {method === "passkey" ? (
        <>
          <p>{passkeyUsable ? _(".prompt.passkey") : _(".prompt.passkey_unsupported")}</p>
          <Button
            type="button"
            primary
            fluid
            icon="key"
            loading={props.pending}
            disabled={!passkeyUsable}
            content={_(".prompt.passkey_button")}
            onClick={confirmWithPasskey}
          />
        </>
      ) : (
        <>
          <p>{method === "totp" ? _(".prompt.totp") : _(".prompt.recovery_code")}</p>
          <Form.Field>
            <Input
              fluid
              autoFocus
              icon={method === "totp" ? "mobile alternate" : "life ring"}
              iconPosition="left"
              placeholder={method === "totp" ? _(".prompt.totp_placeholder") : _(".prompt.recovery_code_placeholder")}
              aria-label={method === "totp" ? _(".prompt.totp_placeholder") : _(".prompt.recovery_code_placeholder")}
              aria-invalid={!!props.error || undefined}
              value={code}
              readOnly={props.pending}
              error={!!props.error}
              autoComplete={method === "totp" ? "one-time-code" : "off"}
              inputMode={method === "totp" ? "numeric" : "text"}
              maxLength={method === "totp" ? 6 : 24}
              onChange={(e, { value }) => {
                const next = method === "totp" ? value.replace(/\D/g, "") : value;
                setCode(next);
                // Authenticator codes are submitted as soon as they are complete.
                if (method === "totp" && next.length === 6 && code.length !== 6) submitCode(next);
              }}
              onKeyPress={onEnterPress(() => submitCode())}
            />
          </Form.Field>
          <Button
            type="button"
            primary
            fluid
            loading={props.pending}
            disabled={method === "totp" ? code.length !== 6 : !code.trim()}
            content={_(".prompt.verify")}
            onClick={() => submitCode()}
          />
        </>
      )}
      {error && <Message error visible size="small" role="alert" content={error} />}
      {methods
        .filter(other => other !== method)
        .map(other => (
          <div key={other} style={{ marginTop: "0.75em" }}>
            <PseudoLink onClick={() => switchTo(other)}>
              <Icon name={other === "passkey" ? "key" : other === "totp" ? "mobile alternate" : "life ring"} />
              {_(`.prompt.use_${other === "recoveryCode" ? "recovery_code" : other}`)}
            </PseudoLink>
          </div>
        ))}
    </>
  );
};

export default TwoFactorPrompt;
