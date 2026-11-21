import React, { useEffect, useRef, useState } from "react";
import { Button, Form, Header, Message } from "semantic-ui-react";
import { observer } from "mobx-react";
import { useLocalizer } from "@/utils/hooks";
import formatFileSize from "@/utils/formatFileSize";
import { saveBlob } from "@/utils/downloadFile";
import {
  DIAGNOSTIC_SELECTION_LIMIT,
  DiagnosticBundleRequestError,
  InvalidSiteSettingsResponse,
  getDiagnosticBundle,
  parseAiJobIds,
  parseSubmissionIds
} from "./api";
import style from "./SiteManagementPage.module.less";

const INCLUDED = ["deployment", "health", "judging", "errors", "ai", "selected"] as const;

/** "llmoj-diagnostics-2026-11-20T15-04-05Z.json": when the server made it, in a name every system accepts */
const bundleFilename = (bundle: Record<string, any>) =>
  `llmoj-diagnostics-${String(bundle.bundle?.generatedAt ?? new Date().toISOString())
    .replace(/\.\d+Z$/, "Z")
    .replace(/[^0-9A-Za-z-]/g, "-")}.json`;

/**
 * The diagnostic bundle: one JSON file describing the site's state, for whoever supports it. The server builds it
 * from allowlisted facts only; this page saves it, after checking any submission and AI job IDs typed in.
 */
export default observer(function DiagnosticsSection() {
  const _ = useLocalizer("site_management");
  const [submissions, setSubmissions] = useState(""),
    [jobs, setJobs] = useState("");
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function errorMessage(value: unknown) {
    if (value instanceof InvalidSiteSettingsResponse) return _(".invalid_response");
    if (value instanceof DiagnosticBundleRequestError) return value.result.requestError(_);
    return _(".request_failed");
  }

  async function download() {
    if (pending) return;
    const submissionIds = parseSubmissionIds(submissions),
      aiJobIds = parseAiJobIds(jobs);
    if (!submissionIds || !aiJobIds) {
      setError(_(".diagnostics.invalid_ids"));
      return;
    }
    if (submissionIds.length > DIAGNOSTIC_SELECTION_LIMIT || aiJobIds.length > DIAGNOSTIC_SELECTION_LIMIT) {
      setError(_(".diagnostics.too_many", { limit: String(DIAGNOSTIC_SELECTION_LIMIT) }));
      return;
    }
    setPending(true);
    setError("");
    setMessage("");
    try {
      const bundle = await getDiagnosticBundle({ submissionIds, aiJobIds });
      const blob = new Blob([JSON.stringify(bundle, null, 2) + "\n"], { type: "application/json" });
      saveBlob(blob, bundleFilename(bundle));
      if (!mounted.current) return;
      const missing = [...(bundle.selected?.missingSubmissionIds ?? []), ...(bundle.selected?.missingAiJobIds ?? [])];
      setMessage(
        _(".diagnostics.downloaded", { size: formatFileSize(blob.size, 1) }) +
          (missing.length ? " " + _(".diagnostics.missing", { ids: missing.join(", ") }) : "")
      );
    } catch (value) {
      if (mounted.current) setError(errorMessage(value));
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  return (
    <section className={style.section}>
      <Header as="h2">{_(".diagnostics.title")}</Header>
      <p>{_(".diagnostics.introduction")}</p>
      <ul>
        {INCLUDED.map(part => (
          <li key={part}>{_(`.diagnostics.includes.${part}`)}</li>
        ))}
      </ul>
      <p>{_(".diagnostics.never")}</p>
      {error && <Message negative role="alert" content={error} />}
      {message && <Message positive role="status" content={message} />}
      <Form>
        <div className={style.limit}>
          <Form.Input
            id="diagnostic-submission-ids"
            label={_(".diagnostics.submission_ids")}
            value={submissions}
            disabled={pending}
            onChange={(_event, data) => setSubmissions(String(data.value))}
          />
          <p className={style.note}>
            {_(".diagnostics.submission_ids_note", { limit: String(DIAGNOSTIC_SELECTION_LIMIT) })}
          </p>
        </div>
        <div className={style.limit}>
          <Form.Input
            id="diagnostic-ai-job-ids"
            label={_(".diagnostics.ai_job_ids")}
            value={jobs}
            disabled={pending}
            onChange={(_event, data) => setJobs(String(data.value))}
          />
          <p className={style.note}>
            {_(".diagnostics.ai_job_ids_note", { limit: String(DIAGNOSTIC_SELECTION_LIMIT) })}
          </p>
        </div>
        <div className={style.actions}>
          <Button
            type="button"
            primary
            icon="download"
            loading={pending}
            disabled={pending}
            content={_(".diagnostics.download")}
            onClick={download}
          />
        </div>
      </Form>
    </section>
  );
});
