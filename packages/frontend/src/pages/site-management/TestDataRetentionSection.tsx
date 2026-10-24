import React, { useEffect, useRef, useState } from "react";
import { Button, Form, Header, Message, Table } from "semantic-ui-react";
import { observer } from "mobx-react";
import { appState } from "@/appState";
import { Link, useLocalizer } from "@/utils/hooks";
import formatFileSize from "@/utils/formatFileSize";
import formatDateTime from "@/utils/formatDateTime";
import { getProblemUrl } from "@/pages/problem/utils";
import {
  TestDataRetentionPolicy,
  TestDataRetentionReport,
  TEST_DATA_RETENTION_RANGES,
  TestDataRetentionRequestError,
  InvalidSiteSettingsResponse,
  getTestDataRetention,
  updateTestDataRetention
} from "./api";
import style from "./SiteManagementPage.module.less";

type Field = keyof TestDataRetentionPolicy;
const FIELDS: Field[] = ["contestDays", "resultDays"];
type Draft = Record<Field, string>;
type Reason = ApiTypes.TestDataRetentionReasonDto;

const toDraft = (policy: TestDataRetentionPolicy): Draft =>
  Object.fromEntries(FIELDS.map(field => [field, String(policy[field])])) as Draft;

/** The policy a draft describes, or null when a number is missing or outside its range. */
function fromDraft(draft: Draft): TestDataRetentionPolicy {
  const policy = {} as TestDataRetentionPolicy;
  for (const field of FIELDS) {
    const text = draft[field].trim();
    const value = Number(text);
    const [min, max] = TEST_DATA_RETENTION_RANGES[field];
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) return null;
    policy[field] = value;
  }
  return policy;
}

/**
 * How long removed test data stays, and a dry run of the next cleanup: every removed file it would delete or keep,
 * and why.
 */
export default observer(function TestDataRetentionSection() {
  const _ = useLocalizer("site_management");
  const [report, setReport] = useState<TestDataRetentionReport>(null);
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
    if (value instanceof TestDataRetentionRequestError) return value.result.requestError(_);
    return _(".request_failed");
  }

  async function load(keepDraft = false) {
    try {
      const value = await getTestDataRetention();
      if (!mounted.current) return;
      setReport(value);
      if (!keepDraft) setDraft(toDraft(value.policy));
    } catch (value) {
      if (mounted.current) setError(errorMessage(value));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const policy = report?.policy;
  const next = draft && fromDraft(draft);
  const dirty = !!policy && !!draft && (!next || FIELDS.some(field => next[field] !== policy[field]));

  async function save() {
    if (!appState.currentUser?.isAdmin || busy.current || !dirty) return;
    if (!next) {
      setError(_(".test_data.invalid"));
      return;
    }
    busy.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      const saved = await updateTestDataRetention(next);
      if (!mounted.current) return;
      setDraft(toDraft(saved));
      setMessage(_(".test_data.saved"));
      // What the next cleanup does under the saved policy
      await load(true);
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

  const size = (bytes: number) => formatFileSize(bytes, 1);
  const date = (value: Date | string) => formatDateTime(value, true)[1];
  function reasonText(reason: Reason) {
    const version = reason.version != null ? _(".test_data.version", { version: String(reason.version) }) : "";
    const until = reason.until ? _(".test_data.until", { date: date(reason.until) }) : "";
    switch (reason.kind) {
      case "Contest":
        return (
          _(".test_data.reasons.Contest", { contest: reason.contestTitle ?? `#${reason.contestId}`, version }) + until
        );
      case "Kept":
        return _(".test_data.reasons.Kept", { username: reason.keptBy ?? _(".test_data.deleted_user"), version });
      default:
        return _(`.test_data.reasons.${reason.kind}`, { version }) + until;
    }
  }
  function actionText(file: ApiTypes.RemovedTestDataFileDto) {
    if (file.action === "Delete") return _(".test_data.actions.Delete");
    if (file.action === "Release") return _(".test_data.actions.Release");
    return file.keptUntil
      ? _(".test_data.actions.KeepUntil", { date: date(file.keptUntil) })
      : _(".test_data.actions.Keep");
  }

  return (
    <section className={style.section}>
      <Header as="h2">{_(".test_data.title")}</Header>
      <p>{_(".test_data.introduction")}</p>
      {error && <Message negative role="alert" content={error} />}
      {message && <Message positive role="status" content={message} />}
      {draft && (
        <Form>
          {FIELDS.map(field => (
            <div key={field} className={style.limit}>
              <Form.Input
                id={`test-data-retention-${field}`}
                type="number"
                min={TEST_DATA_RETENTION_RANGES[field][0]}
                max={TEST_DATA_RETENTION_RANGES[field][1]}
                step={1}
                label={_(`.test_data.fields.${field}`)}
                value={draft[field]}
                disabled={pending}
                onChange={(_event, data) => change({ [field]: String(data.value) })}
              />
              <p className={style.note}>{_(`.test_data.notes.${field}`)}</p>
            </div>
          ))}
          <div className={style.actions}>
            <Button type="button" primary loading={pending} disabled={pending || !dirty} onClick={save}>
              {_(".save")}
            </Button>
            <Button
              type="button"
              icon="refresh"
              content={_(".test_data.refresh")}
              disabled={pending}
              onClick={() => void load(true)}
            />
          </div>
        </Form>
      )}
      {report && (
        <>
          <Header as="h3">{_(".test_data.dry_run")}</Header>
          <p>
            {report.removed.files === 0
              ? _(".test_data.nothing_removed")
              : _(".test_data.summary", {
                  files: String(report.removed.files),
                  size: size(report.removed.bytes),
                  minutes: String(report.cleanupMinutes),
                  deleteFiles: String(report.deletedAtNextCleanup.files),
                  deleteSize: size(report.deletedAtNextCleanup.bytes),
                  keepFiles: String(report.kept.files),
                  keepSize: size(report.kept.bytes)
                })}
          </p>
          {report.byReason.length > 0 && (
            <Table unstackable compact className={style.usageTable}>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{_(".test_data.kept_because")}</Table.HeaderCell>
                  <Table.HeaderCell>{_(".test_data.files")}</Table.HeaderCell>
                  <Table.HeaderCell>{_(".test_data.size")}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {report.byReason.map(reason => (
                  <Table.Row key={reason.kind}>
                    <Table.Cell>{_(`.test_data.reason_kinds.${reason.kind}`)}</Table.Cell>
                    <Table.Cell>{reason.files}</Table.Cell>
                    <Table.Cell>{size(reason.bytes)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
          {report.files.length > 0 && (
            <>
              <Table unstackable compact className={style.usageTable}>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{_(".test_data.file")}</Table.HeaderCell>
                    <Table.HeaderCell>{_(".test_data.size")}</Table.HeaderCell>
                    <Table.HeaderCell>{_(".test_data.removed_at")}</Table.HeaderCell>
                    <Table.HeaderCell>{_(".test_data.next_cleanup")}</Table.HeaderCell>
                    <Table.HeaderCell>{_(".test_data.why")}</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {report.files.map((file, i) => (
                    <Table.Row key={i} negative={file.action === "Delete"}>
                      <Table.Cell>
                        {file.problemId ? (
                          <Link
                            href={getProblemUrl(file.problemDisplayId || file.problemId, {
                              use: file.problemDisplayId ? "displayId" : "id",
                              subRoute: "files"
                            })}
                          >
                            {file.problemDisplayId ? `#${file.problemDisplayId}` : `P${file.problemId}`}
                          </Link>
                        ) : (
                          _(".test_data.no_problem")
                        )}{" "}
                        <span className={style.address}>{file.filename ?? _(".test_data.unnamed")}</span>
                        {file.versions.length > 0 &&
                          ` (${file.versions.map(version => _(".test_data.version", { version: String(version) })).join(", ")})`}
                      </Table.Cell>
                      <Table.Cell>{file.size == null ? "-" : size(file.size)}</Table.Cell>
                      <Table.Cell>{formatDateTime(file.removedAt)[1]}</Table.Cell>
                      <Table.Cell>{actionText(file)}</Table.Cell>
                      <Table.Cell>
                        {file.reasons.length === 0
                          ? file.action === "Release"
                            ? _(".test_data.used_again")
                            : _(".test_data.nothing_needs_it")
                          : file.reasons.map((reason, j) => <div key={j}>{reasonText(reason)}</div>)}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
              {report.files.length < report.total && (
                <p className={style.note}>
                  {_(".test_data.showing", { shown: String(report.files.length), total: String(report.total) })}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
});
