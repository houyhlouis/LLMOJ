import React, { useState } from "react";
import {
  Button,
  Header,
  Icon,
  Input,
  Label,
  List,
  Message,
  Modal,
  Popup,
  Segment,
  SegmentGroup
} from "semantic-ui-react";
import { observer } from "mobx-react";
import { UAParser } from "ua-parser-js";

import style from "./UserEdit.module.less";

import api from "@/api";
import { appState } from "@/appState";
import QrCode from "@/components/QrCode";
import toast from "@/utils/toast";
import { useAsyncCallbackPending, useLocalizer } from "@/utils/hooks";
import formatDateTime from "@/utils/formatDateTime";
import { createPasskey, isPasskeyCancelled, isPasskeySupported } from "@/utils/webauthn";

interface TwoFactorSettingsProps {
  meta: ApiTypes.UserMetaDto;
  status: ApiTypes.TwoFactorStatusDto;
}

function defaultPasskeyName() {
  const { browser, os } = new UAParser().getResult();
  return [browser.name, os.name].filter(Boolean).join(" · ").slice(0, 80) || "Passkey";
}

// A button asking for confirmation in a popup, which closes when confirmed (e.g. before a password dialog opens).
const ConfirmButton: React.FC<{
  trigger: React.ReactElement;
  confirm: string;
  onConfirm: () => void;
  position?: "top center" | "left center";
}> = props => {
  const [open, setOpen] = useState(false);
  return (
    <Popup
      trigger={props.trigger}
      content={
        <Button
          negative
          content={props.confirm}
          onClick={() => {
            setOpen(false);
            props.onConfirm();
          }}
        />
      }
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      on="click"
      position={props.position ?? "top center"}
    />
  );
};

// Show the authenticator secret in groups of four, as most apps display it.
const groupedSecret = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();

const TwoFactorSettings: React.FC<TwoFactorSettingsProps> = props => {
  const _ = useLocalizer("user_edit.security.two_factor");
  const isCurrentUser = props.meta.id === appState.currentUser.id;
  const [status, setStatus] = useState(props.status);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>(null);

  async function refresh() {
    const { response } = await api.twoFactor.getStatus({ userId: props.meta.id });
    if (response?.status) setStatus(response.status);
  }

  // Requests that needed a password the user then didn't enter are left without a message.
  function failed(error: string) {
    if (error !== "REAUTHENTICATION_REQUIRED") toast.error(_(`.errors.${error}`));
  }

  // Authenticator app
  const [totpSetup, setTotpSetup] = useState<{ secret: string; uri: string }>(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpCodeInvalid, setTotpCodeInvalid] = useState(false);
  const [pendingBeginTotp, onBeginTotp] = useAsyncCallbackPending(async () => {
    const { requestError, response } = await api.twoFactor.beginTotpSetup();
    if (requestError) toast.error(requestError(_));
    else if (response.error) failed(response.error);
    else {
      setTotpSetup({ secret: response.secret, uri: response.uri });
      setTotpCode("");
      setTotpCodeInvalid(false);
    }
  });
  const [pendingConfirmTotp, onConfirmTotp] = useAsyncCallbackPending(async () => {
    if (!/^\d{6}$/.test(totpCode)) return setTotpCodeInvalid(true);
    const { requestError, response } = await api.twoFactor.confirmTotpSetup({ code: totpCode });
    if (requestError) toast.error(requestError(_));
    else if (response.error === "INVALID_CODE") setTotpCodeInvalid(true);
    else if (response.error) {
      failed(response.error);
      if (response.error === "SETUP_EXPIRED") setTotpSetup(null);
    } else {
      setTotpSetup(null);
      toast.success(_(".totp.enabled"));
      if (response.recoveryCodes) setRecoveryCodes(response.recoveryCodes);
      await refresh();
    }
  });
  const [pendingDisableTotp, onDisableTotp] = useAsyncCallbackPending(async () => {
    const { requestError, response } = await api.twoFactor.disableTotp();
    if (requestError) toast.error(requestError(_));
    else if (response.error) failed(response.error);
    else {
      toast.success(_(".totp.disabled"));
      await refresh();
    }
  });

  // Passkeys
  const passkeySupported = isPasskeySupported();
  const [passkeyName, setPasskeyName] = useState(defaultPasskeyName);
  const [pendingAddPasskey, onAddPasskey] = useAsyncCallbackPending(async () => {
    const begun = await api.twoFactor.beginPasskeyRegistration();
    if (begun.requestError) return toast.error(begun.requestError(_));
    if (begun.response.error) return failed(begun.response.error);
    let credential: ApiTypes.PasskeyRegistrationDto;
    try {
      credential = await createPasskey(begun.response.options);
    } catch (e) {
      if (isPasskeyCancelled(e)) toast.error(_(".passkeys.cancelled"));
      else if (e instanceof DOMException && e.name === "InvalidStateError") toast.error(_(".passkeys.already_added"));
      else toast.error(_(".passkeys.browser_error", { message: e.message }));
      return;
    }
    const { requestError, response } = await api.twoFactor.finishPasskeyRegistration({
      name: passkeyName.trim() || defaultPasskeyName(),
      credential
    });
    if (requestError) toast.error(requestError(_));
    else if (response.error) failed(response.error);
    else {
      toast.success(_(".passkeys.added"));
      if (response.recoveryCodes) setRecoveryCodes(response.recoveryCodes);
      await refresh();
    }
  });
  const [, onRemovePasskey] = useAsyncCallbackPending(async (id: number) => {
    const { requestError, response } = await api.twoFactor.removePasskey({ id });
    if (requestError) toast.error(requestError(_));
    else if (response.error) failed(response.error);
    else {
      toast.success(_(".passkeys.removed"));
      await refresh();
    }
  });

  // Recovery codes
  const [pendingRegenerate, onRegenerate] = useAsyncCallbackPending(async () => {
    const { requestError, response } = await api.twoFactor.regenerateRecoveryCodes();
    if (requestError) toast.error(requestError(_));
    else if (response.error) failed(response.error);
    else {
      setRecoveryCodes(response.recoveryCodes);
      await refresh();
    }
  });

  function downloadRecoveryCodes() {
    const text = `${appState.serverPreference.siteName} - ${props.meta.username}\n\n${recoveryCodes.join("\n")}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${appState.serverPreference.siteName}-recovery-codes.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // A user manager turns off every second factor for a user who lost them.
  const [pendingReset, onReset] = useAsyncCallbackPending(async () => {
    const { requestError, response } = await api.twoFactor.resetUserTwoFactor({ userId: props.meta.id });
    if (requestError) toast.error(requestError(_));
    else if (response.error) failed(response.error);
    else {
      toast.success(_(".reset.success"));
      await refresh();
    }
  });

  const methodsSummary = [
    status.totp && _(".method_totp"),
    status.passkeys.length && _(".method_passkeys", { count: String(status.passkeys.length) })
  ]
    .filter(Boolean)
    .join(_(".separator"));

  const statusLabel = (
    <Label color={status.enabled ? "green" : "grey"} content={status.enabled ? _(".on") : _(".off")} size="small" />
  );

  if (!isCurrentUser)
    return (
      <>
        <Header className={style.sectionHeader} size="large" content={_(".header")} />
        <p>
          {statusLabel} {status.enabled ? _(".on_notes_other", { methods: methodsSummary }) : _(".off_notes_other")}
        </p>
        {status.enabled && (
          <>
            <ConfirmButton
              trigger={<Button negative basic loading={pendingReset} content={_(".reset.button")} />}
              confirm={_(".reset.confirm")}
              onConfirm={onReset}
            />
            <div className={style.notes}>{_(".reset.notes")}</div>
          </>
        )}
      </>
    );

  return (
    <>
      <Modal size="small" open={!!recoveryCodes} closeOnDimmerClick={false}>
        <Header icon="life ring" content={_(".recovery_codes.header")} />
        <Modal.Content>
          <p>{_(".recovery_codes.save_notes")}</p>
          <Segment>
            <List style={{ fontFamily: "monospace", fontSize: "1.15em", columns: 2 }}>
              {recoveryCodes?.map(code => (
                <List.Item key={code}>{code}</List.Item>
              ))}
            </List>
          </Segment>
        </Modal.Content>
        <Modal.Actions>
          <Button icon="download" content={_(".recovery_codes.download")} onClick={downloadRecoveryCodes} />
          <Button
            icon="copy"
            content={_(".recovery_codes.copy")}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(recoveryCodes.join("\n"));
                toast.success(_(".recovery_codes.copied"));
              } catch {
                toast.error(_(".recovery_codes.copy_failed"));
              }
            }}
          />
          <Button primary content={_(".recovery_codes.done")} onClick={() => setRecoveryCodes(null)} />
        </Modal.Actions>
      </Modal>

      <Header className={style.sectionHeader} size="large" content={_(".header")} />
      <p>
        {statusLabel} {status.enabled ? _(".on_notes", { methods: methodsSummary }) : _(".off_notes")}
      </p>

      <Header className={style.header} size="small" content={_(".totp.header")} />
      {status.totp ? (
        <>
          <p>
            <Icon name="mobile alternate" />
            {_(".totp.enabled_since", { time: formatDateTime(status.totpEnabledAt)[1] })}
          </p>
          <ConfirmButton
            trigger={<Button basic negative loading={pendingDisableTotp} content={_(".totp.disable")} />}
            confirm={_(".totp.confirm_disable")}
            onConfirm={onDisableTotp}
          />
        </>
      ) : totpSetup ? (
        <Segment>
          <p>{_(".totp.scan")}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "1.5em", alignItems: "center" }}>
            <QrCode value={totpSetup.uri} size={180} title={_(".totp.qr_title")} />
            <div style={{ flex: "1 1 220px" }}>
              <div className={style.notes}>{_(".totp.manual")}</div>
              <code style={{ fontSize: "1.1em", wordBreak: "break-all" }}>{groupedSecret(totpSetup.secret)}</code>
              <Header className={style.header} size="tiny" content={_(".totp.code")} />
              <Input
                fluid
                value={totpCode}
                placeholder="000000"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                error={totpCodeInvalid}
                onChange={(e, { value }) => {
                  setTotpCode(value.replace(/\D/g, ""));
                  setTotpCodeInvalid(false);
                }}
              />
              <div className={style.notes}>{totpCodeInvalid && _(".totp.invalid_code")}</div>
            </div>
          </div>
          <Button
            className={style.submit}
            primary
            loading={pendingConfirmTotp}
            content={_(".totp.enable")}
            onClick={onConfirmTotp}
          />
          <Button className={style.submit} content={_(".cancel")} onClick={() => setTotpSetup(null)} />
        </Segment>
      ) : (
        <>
          <p className={style.notes}>{_(".totp.notes")}</p>
          <Button primary loading={pendingBeginTotp} content={_(".totp.set_up")} onClick={onBeginTotp} />
        </>
      )}

      <Header className={style.header} size="small" content={_(".passkeys.header")} />
      {status.passkeys.length > 0 && (
        <SegmentGroup>
          {status.passkeys.map(passkey => (
            <Segment key={passkey.id} style={{ display: "flex", alignItems: "center", gap: "1em" }}>
              <Icon name="key" size="large" />
              <div style={{ flexGrow: 1 }}>
                <div>
                  <strong>{passkey.name}</strong>
                </div>
                <div className={style.notes}>
                  {_(".passkeys.details", {
                    site: passkey.rpId,
                    created: formatDateTime(passkey.createdAt, true)[1],
                    used: passkey.lastUsedAt ? formatDateTime(passkey.lastUsedAt)[1] : _(".passkeys.never_used")
                  })}
                </div>
              </div>
              <ConfirmButton
                trigger={<Button content={_(".passkeys.remove")} />}
                confirm={_(".passkeys.confirm_remove")}
                onConfirm={() => onRemovePasskey(passkey.id)}
                position="left center"
              />
            </Segment>
          ))}
        </SegmentGroup>
      )}
      {passkeySupported ? (
        <>
          <p className={style.notes}>{_(".passkeys.notes")}</p>
          <Input
            className={style.notFullWidth}
            fluid
            value={passkeyName}
            maxLength={80}
            placeholder={_(".passkeys.name")}
            onChange={(e, { value }) => setPasskeyName(value)}
            action={
              <Button
                primary
                icon="plus"
                loading={pendingAddPasskey}
                content={_(".passkeys.add")}
                onClick={onAddPasskey}
              />
            }
          />
        </>
      ) : (
        <Message info size="small" content={_(".passkeys.unavailable")} />
      )}

      {status.enabled && (
        <>
          <Header className={style.header} size="small" content={_(".recovery_codes.header")} />
          <p>{_(".recovery_codes.remaining", { count: String(status.recoveryCodesRemaining) })}</p>
          <ConfirmButton
            trigger={<Button loading={pendingRegenerate} content={_(".recovery_codes.regenerate")} />}
            confirm={_(".recovery_codes.confirm_regenerate")}
            onConfirm={onRegenerate}
          />
          <div className={style.notes}>{_(".recovery_codes.notes")}</div>
        </>
      )}
    </>
  );
};

export default observer(TwoFactorSettings);
