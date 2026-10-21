import React, { useEffect, useRef, useState } from "react";
import { Button, Form, Header, Message } from "semantic-ui-react";
import { observer } from "mobx-react";
import { appState } from "@/appState";
import { useLocalizer } from "@/utils/hooks";
import {
  JudgePolicy,
  JUDGE_POLICY_RANGES,
  JudgePolicyRequestError,
  InvalidSiteSettingsResponse,
  getJudgePolicy,
  updateJudgePolicy
} from "./api";
import style from "./SiteManagementPage.module.less";

type Field = keyof JudgePolicy;
const FIELDS: Field[] = ["contestReservedThreads", "agingMinutes"];
type Draft = Record<Field, string>;

const toDraft = (policy: JudgePolicy): Draft =>
  Object.fromEntries(FIELDS.map(field => [field, String(policy[field])])) as Draft;

/** The policy a draft describes, or null when a number is missing or outside its range. */
function fromDraft(draft: Draft): JudgePolicy {
  const policy = {} as JudgePolicy;
  for (const field of FIELDS) {
    const text = draft[field].trim();
    const value = Number(text);
    const [min, max] = JUDGE_POLICY_RANGES[field];
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) return null;
    policy[field] = value;
  }
  return policy;
}

export default observer(function JudgePolicySection() {
  const _ = useLocalizer("site_management");
  const [policy, setPolicy] = useState<JudgePolicy>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
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
    if (value instanceof JudgePolicyRequestError) return value.result.requestError(_);
    return _(".request_failed");
  }

  useEffect(() => {
    void getJudgePolicy()
      .then(value => {
        if (!mounted.current) return;
        setPolicy(value);
        setDraft(toDraft(value));
      })
      .catch(value => {
        if (mounted.current) setError(errorMessage(value));
      });
  }, []);

  const next = draft && fromDraft(draft);
  const dirty = !!policy && !!draft && (!next || FIELDS.some(field => next[field] !== policy[field]));

  async function save() {
    if (!appState.currentUser?.isAdmin || busy.current || !dirty) return;
    if (!next) {
      setError(_(".judging.invalid"));
      return;
    }
    busy.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      const saved = await updateJudgePolicy(next);
      if (!mounted.current) return;
      setPolicy(saved);
      setDraft(toDraft(saved));
      setMessage(_(".judging.saved"));
    } catch (value) {
      if (mounted.current) setError(_(".save_unconfirmed", { error: errorMessage(value) }));
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  const change = (values: Partial<Draft>) => {
    if (busy.current) return;
    setDraft(previous => ({ ...previous, ...values }));
    setError("");
    setMessage("");
  };

  return (
    <section className={style.section}>
      <Header as="h2">{_(".judging.title")}</Header>
      <p>{_(".judging.introduction")}</p>
      {error && <Message negative role="alert" content={error} />}
      {message && <Message positive role="status" content={message} />}
      {draft && (
        <Form>
          {FIELDS.map(field => (
            <div key={field} className={style.limit}>
              <Form.Input
                id={`judge-policy-${field}`}
                type="number"
                min={JUDGE_POLICY_RANGES[field][0]}
                max={JUDGE_POLICY_RANGES[field][1]}
                step={1}
                label={_(`.judging.fields.${field}`)}
                value={draft[field]}
                disabled={pending}
                onChange={(_event, data) => change({ [field]: String(data.value) })}
              />
              <p className={style.note}>{_(`.judging.notes.${field}`)}</p>
            </div>
          ))}
          <div className={style.actions}>
            <Button type="button" primary loading={pending} disabled={pending || !dirty} onClick={save}>
              {_(".save")}
            </Button>
          </div>
        </Form>
      )}
    </section>
  );
});
