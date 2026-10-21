import React, { useEffect, useRef, useState } from "react";
import { Button, Form, Header, Label, Message, Table } from "semantic-ui-react";
import { observer } from "mobx-react";
import { appState } from "@/appState";
import { useLocalizer } from "@/utils/hooks";
import {
  AI_ENDPOINT_TYPES,
  AiApprovedEndpoint,
  AiEndpointPolicy,
  AiEndpointPolicyRequestError,
  AiEndpointType,
  AiEndpointUsage,
  AiEndpointUsageError,
  InvalidSiteSettingsResponse,
  listAiEndpointUsage,
  getAiEndpointPolicy,
  updateAiEndpointPolicy
} from "./api";
import style from "./SiteManagementPage.module.less";

const MAX_ENDPOINTS = 50;

const TYPE_NAMES: Record<AiEndpointType, string> = {
  chat: "OpenAI Compatible (Chat Completions)",
  responses: "Responses",
  anthropic: "Anthropic Messages",
  tavily: "Tavily",
  mcp: "MCP"
};

// The form the server stores: no trailing slash
const normalize = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, "");

function validEndpoint(endpoint: AiApprovedEndpoint): boolean {
  if (!endpoint.name.trim() || endpoint.name.trim().length > 80) return false;
  try {
    const url = new URL(endpoint.baseUrl.trim());
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

const samePolicy = (a: AiEndpointPolicy, b: AiEndpointPolicy) =>
  a.customEndpoints === b.customEndpoints &&
  a.endpoints.length === b.endpoints.length &&
  a.endpoints.every(
    (endpoint, i) =>
      endpoint.name.trim() === b.endpoints[i].name.trim() &&
      endpoint.type === b.endpoints[i].type &&
      normalize(endpoint.baseUrl) === normalize(b.endpoints[i].baseUrl)
  );

export default observer(function AiEndpointsSection() {
  const _ = useLocalizer("site_management");
  const [policy, setPolicy] = useState<AiEndpointPolicy>(null);
  const [draft, setDraft] = useState<AiEndpointPolicy>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [usage, setUsage] = useState<AiEndpointUsage[]>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState("");
  const mounted = useRef(true);
  const busy = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function errorMessage(value: unknown) {
    if (value instanceof InvalidSiteSettingsResponse) return _(".invalid_response");
    if (value instanceof AiEndpointPolicyRequestError) return value.result.requestError(_);
    if (value instanceof AiEndpointUsageError && value.result.requestError) return value.result.requestError(_);
    return _(".request_failed");
  }

  useEffect(() => {
    void getAiEndpointPolicy()
      .then(value => {
        if (!mounted.current) return;
        setPolicy(value);
        setDraft(value);
      })
      .catch(value => {
        if (mounted.current) setError(errorMessage(value));
      });
  }, []);

  const dirty = !!policy && !!draft && !samePolicy(policy, draft);

  const change = (next: Partial<AiEndpointPolicy>) => {
    if (busy.current) return;
    setDraft(previous => ({ ...previous, ...next }));
    setError("");
    setMessage("");
  };
  const changeEndpoint = (index: number, values: Partial<AiApprovedEndpoint>) =>
    change({ endpoints: draft.endpoints.map((endpoint, i) => (i === index ? { ...endpoint, ...values } : endpoint)) });
  const addEndpoint = (endpoint: AiApprovedEndpoint) => change({ endpoints: [...draft.endpoints, endpoint] });

  async function save() {
    if (!appState.currentUser?.isAdmin || busy.current || !dirty) return;
    if (!draft.endpoints.every(validEndpoint)) {
      setError(_(".ai_endpoints.invalid"));
      return;
    }
    busy.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      const saved = await updateAiEndpointPolicy({
        customEndpoints: draft.customEndpoints,
        endpoints: draft.endpoints.map(endpoint => ({
          name: endpoint.name.trim(),
          type: endpoint.type,
          baseUrl: normalize(endpoint.baseUrl)
        }))
      });
      if (!mounted.current) return;
      setPolicy(saved);
      setDraft(saved);
      setUsage(null);
      setMessage(_(".ai_endpoints.saved"));
    } catch (value) {
      if (mounted.current) setError(_(".save_unconfirmed", { error: errorMessage(value) }));
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  async function loadUsage() {
    if (usageLoading) return;
    setUsageLoading(true);
    setUsageError("");
    try {
      const endpoints = await listAiEndpointUsage();
      if (mounted.current) setUsage(endpoints);
    } catch (value) {
      if (mounted.current) setUsageError(errorMessage(value));
    } finally {
      if (mounted.current) setUsageLoading(false);
    }
  }

  const approvedInDraft = (baseUrl: string) =>
    draft.endpoints.some(endpoint => {
      try {
        const base = new URL(normalize(endpoint.baseUrl));
        const url = new URL(baseUrl);
        const prefix = base.pathname.replace(/\/+$/, "");
        return (
          base.origin === url.origin &&
          (prefix === "" || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
        );
      } catch {
        return false;
      }
    });

  return (
    <section className={style.section}>
      <Header as="h2">{_(".ai_endpoints.title")}</Header>
      <p>{_(".ai_endpoints.introduction")}</p>
      {error && <Message negative role="alert" content={error} />}
      {message && <Message positive role="status" content={message} />}
      {draft && (
        <Form>
          <Form.Group grouped>
            <label>{_(".ai_endpoints.custom_label")}</label>
            {(["public", "approved"] as const).map(value => (
              <Form.Radio
                key={value}
                id={`ai-endpoints-${value}`}
                label={_(`.ai_endpoints.custom.${value}`)}
                value={value}
                checked={draft.customEndpoints === value}
                disabled={pending}
                onChange={() => change({ customEndpoints: value })}
              />
            ))}
          </Form.Group>
          <p className={style.note}>{_(".ai_endpoints.custom_notes")}</p>

          <Header as="h3">{_(".ai_endpoints.approved_title")}</Header>
          {draft.endpoints.length === 0 ? (
            <p>{_(".ai_endpoints.none_approved")}</p>
          ) : (
            draft.endpoints.map((endpoint, index) => (
              <div key={index} className={style.endpoint}>
                <Form.Group widths="equal">
                  <Form.Input
                    id={`ai-endpoint-${index}-name`}
                    label={_(".ai_endpoints.name")}
                    value={endpoint.name}
                    maxLength={80}
                    disabled={pending}
                    onChange={(_event, data) => changeEndpoint(index, { name: String(data.value) })}
                  />
                  <Form.Select
                    id={`ai-endpoint-${index}-type`}
                    label={_(".ai_endpoints.type")}
                    value={endpoint.type}
                    options={AI_ENDPOINT_TYPES.map(type => ({ key: type, value: type, text: TYPE_NAMES[type] }))}
                    disabled={pending}
                    onChange={(_event, data) => changeEndpoint(index, { type: data.value as AiEndpointType })}
                  />
                </Form.Group>
                <div className={style.endpointAddress}>
                  <Form.Input
                    id={`ai-endpoint-${index}-url`}
                    label={_(".ai_endpoints.base_url")}
                    value={endpoint.baseUrl}
                    maxLength={500}
                    placeholder="http://192.168.1.20:11434/v1"
                    disabled={pending}
                    onChange={(_event, data) => changeEndpoint(index, { baseUrl: String(data.value) })}
                  />
                  <Button
                    type="button"
                    icon="trash"
                    aria-label={_(".ai_endpoints.remove_named", { name: endpoint.name || endpoint.baseUrl })}
                    disabled={pending}
                    onClick={() => change({ endpoints: draft.endpoints.filter((_endpoint, i) => i !== index) })}
                  />
                </div>
              </div>
            ))
          )}
          <p className={style.note}>{_(".ai_endpoints.approved_notes")}</p>
          <div className={style.actions}>
            <Button
              type="button"
              icon="plus"
              content={_(".ai_endpoints.add")}
              disabled={pending || draft.endpoints.length >= MAX_ENDPOINTS}
              onClick={() => addEndpoint({ name: "", type: "chat", baseUrl: "" })}
            />
            <Button type="button" primary loading={pending} disabled={pending || !dirty} onClick={save}>
              {_(".save")}
            </Button>
          </div>

          <Header as="h3">{_(".ai_endpoints.usage_title")}</Header>
          <p>{_(".ai_endpoints.usage_introduction")}</p>
          {usageError && <Message negative role="alert" content={usageError} />}
          <Button
            type="button"
            icon="search"
            content={usage ? _(".ai_endpoints.usage_reload") : _(".ai_endpoints.usage_load")}
            loading={usageLoading}
            disabled={usageLoading}
            onClick={loadUsage}
          />
          {usage &&
            (usage.length === 0 ? (
              <p role="status">{_(".ai_endpoints.usage_none")}</p>
            ) : (
              <Table unstackable compact className={style.usageTable}>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{_(".ai_endpoints.base_url")}</Table.HeaderCell>
                    <Table.HeaderCell>{_(".ai_endpoints.type")}</Table.HeaderCell>
                    <Table.HeaderCell>{_(".ai_endpoints.accounts")}</Table.HeaderCell>
                    <Table.HeaderCell>{_(".ai_endpoints.status")}</Table.HeaderCell>
                    <Table.HeaderCell collapsing />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {usage.map(row => (
                    <Table.Row key={`${row.kind} ${row.type} ${row.baseUrl}`}>
                      <Table.Cell className={style.address}>{row.baseUrl}</Table.Cell>
                      <Table.Cell>{TYPE_NAMES[row.type as AiEndpointType] ?? row.type}</Table.Cell>
                      <Table.Cell>
                        {row.administratorAccounts
                          ? _(".ai_endpoints.accounts_with_administrators", {
                              count: row.accounts,
                              administrators: row.administratorAccounts
                            })
                          : row.accounts}
                      </Table.Cell>
                      <Table.Cell>
                        <Label
                          basic
                          color={row.status === "approved" ? "green" : row.status === "public" ? undefined : "orange"}
                        >
                          {_(`.ai_endpoints.statuses.${row.status}`)}
                        </Label>
                        {row.destination === "unresolved" && (
                          <span className={style.note}> {_(".ai_endpoints.unresolved")}</span>
                        )}
                      </Table.Cell>
                      <Table.Cell collapsing>
                        {row.status !== "approved" &&
                          (approvedInDraft(row.baseUrl) ? (
                            _(".ai_endpoints.approval_unsaved")
                          ) : (
                            <Button
                              type="button"
                              size="small"
                              disabled={pending || draft.endpoints.length >= MAX_ENDPOINTS}
                              onClick={() =>
                                addEndpoint({
                                  name: new URL(row.baseUrl).host,
                                  type: (AI_ENDPOINT_TYPES as readonly string[]).includes(row.type)
                                    ? (row.type as AiEndpointType)
                                    : "chat",
                                  baseUrl: row.baseUrl
                                })
                              }
                            >
                              {_(".ai_endpoints.approve")}
                            </Button>
                          ))}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            ))}
        </Form>
      )}
    </section>
  );
});
