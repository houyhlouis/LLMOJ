import React, { useEffect, useRef, useState } from "react";
import { Button, Dropdown, Form, Header, Icon, Loader, Message } from "semantic-ui-react";
import { observer } from "mobx-react";
import { defineRoute } from "@/AppRouter";
import { appState } from "@/appState";
import { useConfirmNavigation, useLocalizer } from "@/utils/hooks";
import {
  getSiteSettings,
  updateRegistrationMode,
  InvalidSiteSettingsResponse,
  SiteSettingsRequestError,
  isRegistrationMode,
  RegistrationMode,
  SiteSettings
} from "./api";
import AiPolicySection from "./AiPolicySection";
import JudgePolicySection from "./JudgePolicySection";
import AiEndpointsSection from "./AiEndpointsSection";
import TestDataRetentionSection from "./TestDataRetentionSection";
import style from "./SiteManagementPage.module.less";

export const SiteManagementPage = observer(() => {
  const _ = useLocalizer("site_management");
  const isAdmin = !!appState.currentUser?.isAdmin;
  const [settings, setSettings] = useState<SiteSettings>(null);
  const [draft, setDraft] = useState<RegistrationMode>("open");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  const request = useRef(0);
  const busy = useRef(false);
  const denied = useRef(false);
  const [, setConfirmNavigation] = useConfirmNavigation();
  const dirty = !!settings && draft !== settings.registrationMode;
  const current = (id: number) => mounted.current && request.current === id && !!appState.currentUser?.isAdmin;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);
  useEffect(() => appState.enterNewPage(_(".title")), [appState.locale]);
  useEffect(() => setConfirmNavigation(isAdmin && (dirty || pending)), [isAdmin, dirty, pending]);

  function apply(value: SiteSettings) {
    denied.current = false;
    setSettings(value);
    setDraft(value.registrationMode);
    appState.serverPreference.security.registrationMode = value.registrationMode;
  }
  function errorMessage(error: unknown) {
    if (error instanceof InvalidSiteSettingsResponse) return _(".invalid_response");
    if (error instanceof SiteSettingsRequestError) return error.result.requestError(_);
    const message = (error as { message?: unknown })?.message;
    return typeof message === "string" && message ? message : _(".request_failed");
  }

  function handleDenied(error: unknown) {
    if (error instanceof SiteSettingsRequestError && [401, 403].includes(error.result.requestErrorStatus)) {
      denied.current = true;
      setSettings(null);
      setMessage("");
      setError(_(".permission_denied"));
      return true;
    }
    return false;
  }

  useEffect(() => {
    const id = ++request.current;
    setSettings(null);
    setError("");
    setMessage("");
    setPending(false);
    if (!isAdmin) {
      busy.current = false;
      setLoading(false);
      return;
    }
    busy.current = true;
    setLoading(true);
    void getSiteSettings()
      .then(value => {
        if (current(id)) apply(value);
      })
      .catch(error => {
        if (current(id) && !handleDenied(error)) setError(errorMessage(error));
      })
      .finally(() => {
        if (current(id)) {
          busy.current = false;
          setLoading(false);
        }
      });
    return () => {
      if (request.current === id) request.current++;
    };
  }, [isAdmin, reload]);

  async function persist(mode: RegistrationMode | null) {
    if (!appState.currentUser?.isAdmin || !settings || busy.current || denied.current) return;
    if (mode === null ? !settings.usesOverride : mode === settings.registrationMode) return;
    const id = ++request.current;
    busy.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      const value = await updateRegistrationMode(mode);
      if (!current(id)) return;
      apply(value);
      setMessage(_(mode === null ? ".restored" : ".saved"));
    } catch (error) {
      if (current(id) && !handleDenied(error)) setError(_(".save_unconfirmed", { error: errorMessage(error) }));
    } finally {
      if (current(id)) {
        busy.current = false;
        setPending(false);
      }
    }
  }

  return (
    <>
      <Header as="h1" className="withIcon">
        <Icon name="settings" />
        {_(".title")}
      </Header>
      {!isAdmin ? (
        <Message negative role="alert" content={_(".permission_denied")} />
      ) : (
        <div className={style.content}>
          <p>{_(".introduction")}</p>
          <Header as="h2">{_(".registration_title")}</Header>
          {error && <Message negative role="alert" content={error} />}
          {message && <Message positive role="status" content={message} />}
          {loading && <Loader active inline="centered" content={_(".loading")} />}
          {settings && (
            <>
              <div className={style.status} aria-live="polite">
                <div>{_(".effective_mode", { mode: _(`.modes.${settings.registrationMode}`) })}</div>
                <div>{_(settings.usesOverride ? ".using_override" : ".using_configuration")}</div>
                <div>{_(".configured_mode", { mode: _(`.modes.${settings.configuredRegistrationMode}`) })}</div>
              </div>
              <Form>
                <Form.Field>
                  <label htmlFor="site-registration-mode">{_(".registration_mode")}</label>
                  <Dropdown
                    id="site-registration-mode"
                    aria-label={_(".registration_mode")}
                    selection
                    fluid
                    value={draft}
                    disabled={pending || loading}
                    options={["open", "approval", "closed"].map(mode => ({
                      key: mode,
                      value: mode,
                      text: _(`.modes.${mode}`)
                    }))}
                    onChange={(_, data) => {
                      if (!appState.currentUser?.isAdmin || busy.current || !isRegistrationMode(data.value)) return;
                      setDraft(data.value);
                      setError("");
                      setMessage("");
                    }}
                  />
                </Form.Field>
                <p>{_(`.descriptions.${draft}`)}</p>
                {dirty && <p className={style.note}>{_(".unsaved")}</p>}
                <div className={style.actions}>
                  <Button
                    type="button"
                    primary
                    loading={pending}
                    disabled={pending || loading || !dirty}
                    onClick={() => persist(draft)}
                  >
                    {_(".save")}
                  </Button>
                  <Button
                    type="button"
                    disabled={pending || loading || !settings.usesOverride}
                    onClick={() => persist(null)}
                  >
                    {_(".restore")}
                  </Button>
                </div>
              </Form>
              <p className={style.note}>{_(".restore_note")}</p>
            </>
          )}
          <Button
            type="button"
            icon="refresh"
            content={_(".refresh")}
            disabled={loading || pending}
            onClick={() => {
              if (busy.current || !appState.currentUser?.isAdmin) return;
              if (dirty && !window.confirm(_(".discard_changes"))) return;
              setReload(value => value + 1);
            }}
          />
          <JudgePolicySection />
          <AiPolicySection />
          <AiEndpointsSection />
          <TestDataRetentionSection />
        </div>
      )}
    </>
  );
});

export default defineRoute(async () => <SiteManagementPage />);
