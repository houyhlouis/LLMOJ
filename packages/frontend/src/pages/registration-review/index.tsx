import React, { useEffect, useRef, useState } from "react";
import { Button, Dropdown, Form, Header, Icon, Loader, Message, Modal, Table } from "semantic-ui-react";
import { observer } from "mobx-react";
import { defineRoute } from "@/AppRouter";
import { appState } from "@/appState";
import api from "@/api";
import { useLocalizer } from "@/utils/hooks";
import style from "./RegistrationReviewPage.module.less";

type Status = ApiTypes.RegistrationReviewDto["status"];
const pageSize = 20;

export const RegistrationReviewPage = observer(() => {
  const _ = useLocalizer("registration_review");
  const hasReviewPrivilege = () =>
    !!appState.currentUserHasPrivilege("ViewSite") && !!appState.currentUserHasPrivilege("ManageRegistrationReviews");
  const canReview = hasReviewPrivilege();
  const [status, setStatus] = useState<Status | "all">("pending");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [reviews, setReviews] = useState<ApiTypes.RegistrationReviewDto[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<"approved" | "rejected" | "">("");
  const [selection, setSelection] = useState<{
    review: ApiTypes.RegistrationReviewDto;
    decision: "approved" | "rejected";
  }>(null);
  const [reason, setReason] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => appState.enterNewPage(_(".title")), [appState.locale]);

  useEffect(() => {
    // Also guard the private queue locally; the server checks the effective privilege on every request.
    if (!canReview) {
      setReviews([]);
      setCount(0);
      setSelection(null);
      setReason("");
      setReviewError("");
      setError("");
      setSuccess("");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    setReviews([]);
    async function load() {
      try {
        const { response, requestError } = await api.auth.listRegistrationReviews({
          ...(status === "all" ? {} : { status }),
          skipCount: (page - 1) * pageSize,
          takeCount: pageSize
        });
        if (cancelled || !hasReviewPrivilege()) return;
        if (requestError) setError(requestError(_));
        else if (response.error === "PERMISSION_DENIED") {
          setError(_(".errors.PERMISSION_DENIED"));
          setReviews([]);
          setCount(0);
          setSelection(null);
          setReason("");
          setReviewError("");
          setSuccess("");
        } else if (response.error) setError(_(`.errors.${response.error}`));
        else {
          const lastPage = Math.max(1, Math.ceil(response.count / pageSize));
          if (page > lastPage) {
            setPage(lastPage);
            return;
          }
          setReviews(response.reviews);
          setCount(response.count);
        }
      } catch {
        if (!cancelled) setError(_(".load_failed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [canReview, status, page, refresh, appState.locale]);

  function select(review: ApiTypes.RegistrationReviewDto, decision: "approved" | "rejected") {
    if (
      savingRef.current ||
      !hasReviewPrivilege() ||
      review.status === "approved" ||
      (review.status === "rejected" && decision !== "approved")
    )
      return;
    setReason("");
    setReviewError("");
    setSuccess("");
    setSelection({ review, decision });
  }
  function close() {
    if (!savingRef.current) setSelection(null);
  }
  async function save() {
    if (!selection || savingRef.current || !hasReviewPrivilege() || reason.length > 500) return;
    savingRef.current = true;
    setSaving(true);
    setReviewError("");
    try {
      const { response, requestError } = await api.auth.reviewRegistration({
        applicationId: selection.review.applicationId,
        decision: selection.decision,
        reason: reason.trim()
      });
      if (!mounted.current || !hasReviewPrivilege()) return;
      if (requestError) setReviewError(requestError(_));
      else if (response.error === "PERMISSION_DENIED") {
        setReviews([]);
        setCount(0);
        setSelection(null);
        setReason("");
        setError(_(".errors.PERMISSION_DENIED"));
        setSuccess("");
      } else if (response.error) {
        setReviewError(_(`.errors.${response.error}`));
        // Another reviewer may have reviewed or removed the application.
        setRefresh(value => value + 1);
      } else {
        setSelection(null);
        setSuccess(selection.decision);
        setRefresh(value => value + 1);
      }
    } catch {
      if (mounted.current) setReviewError(_(".save_failed"));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  function date(value: string) {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? "—"
      : new Intl.DateTimeFormat(appState.locale === "zh_CN" ? "zh-CN" : "en-US", {
          dateStyle: "medium",
          timeStyle: "short"
        }).format(parsed);
  }
  const lastPage = Math.max(1, Math.ceil(count / pageSize));

  return (
    <>
      <Header as="h1" className="withIcon">
        <Icon name="users" />
        {_(".title")}
      </Header>
      {!canReview ? (
        <Message negative role="alert" content={_(".errors.PERMISSION_DENIED")} />
      ) : (
        <>
          <p>{_(".introduction")}</p>
          <div className={style.toolbar}>
            <label htmlFor="registration-review-status">{_(".filter")}</label>
            <Dropdown
              id="registration-review-status"
              aria-label={_(".filter")}
              selection
              value={status}
              disabled={saving}
              options={["pending", "approved", "rejected", "all"].map(value => ({
                key: value,
                value,
                text: _(`.status.${value}`)
              }))}
              onChange={(_, data) => {
                setStatus(data.value as Status | "all");
                setPage(1);
                setSuccess("");
              }}
            />
            <Button
              disabled={loading || saving}
              icon="refresh"
              content={_(".refresh")}
              onClick={() => setRefresh(value => value + 1)}
            />
          </div>
          {success && <Message positive role="status" content={_(`.success.${success}`)} />}
          {error && <Message negative role="alert" content={error} />}
          <div aria-busy={loading}>
            {loading ? (
              <Loader active inline="centered">
                {_(".loading")}
              </Loader>
            ) : !error && reviews.length === 0 ? (
              <Message content={_(".empty")} />
            ) : !error ? (
              <div className={style.tableContainer}>
                <Table unstackable>
                  <Table.Header>
                    <Table.Row>
                      {["account", "registered", "state", "review", "actions"].map(key => (
                        <Table.HeaderCell key={key}>{_(`.${key}`)}</Table.HeaderCell>
                      ))}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {reviews.map(review => (
                      <Table.Row key={review.applicationId}>
                        <Table.Cell>
                          <strong>{review.username}</strong>
                          {review.status === "approved" && review.userId != null && (
                            <span> {_(".user_id", { id: review.userId })}</span>
                          )}
                          <div>{review.email}</div>
                        </Table.Cell>
                        <Table.Cell>{date(review.registrationTime)}</Table.Cell>
                        <Table.Cell>
                          <span className={style.status} data-registration-status={review.status}>
                            {_(`.status.${review.status}`)}
                          </span>
                        </Table.Cell>
                        <Table.Cell>
                          {review.reviewedBy != null && <div>{_(".reviewer", { id: review.reviewedBy })}</div>}
                          <div>{date(review.reviewedAt)}</div>
                          <div className={style.reason}>{review.reason || ""}</div>
                        </Table.Cell>
                        <Table.Cell collapsing>
                          {review.status !== "approved" ? (
                            <>
                              <Button
                                size="small"
                                positive
                                disabled={saving}
                                onClick={() => select(review, "approved")}
                              >
                                {_(".approve")}
                              </Button>
                              {review.status === "pending" && (
                                <Button
                                  size="small"
                                  negative
                                  disabled={saving}
                                  onClick={() => select(review, "rejected")}
                                >
                                  {_(".reject")}
                                </Button>
                              )}
                            </>
                          ) : (
                            "—"
                          )}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            ) : null}
          </div>
          {!error && !loading && (
            <div className={style.toolbar}>
              <Button disabled={page <= 1 || saving} onClick={() => setPage(value => value - 1)}>
                {_(".previous")}
              </Button>
              <span>{_(".pagination", { page, pages: lastPage, count })}</span>
              <Button disabled={page >= lastPage || saving} onClick={() => setPage(value => value + 1)}>
                {_(".next")}
              </Button>
            </div>
          )}
          <Modal open={!!selection} onClose={close} size="small" closeOnDimmerClick={!saving} closeOnEscape={!saving}>
            <Modal.Header>
              {selection &&
                _(
                  selection.decision === "rejected"
                    ? ".confirm_reject"
                    : selection.review.status === "rejected"
                    ? ".confirm_reapprove"
                    : ".confirm_approve",
                  {
                    username: selection.review.username
                  }
                )}
            </Modal.Header>
            <Modal.Content>
              <p>{_(selection?.review.status === "rejected" ? ".reapprove_notice" : ".final_decision")}</p>
              {reviewError && <Message negative role="alert" content={reviewError} />}
              <Form>
                <Form.TextArea
                  label={_(".note")}
                  value={reason}
                  maxLength={500}
                  disabled={saving}
                  onChange={(_, data) => setReason(String(data.value))}
                />
                <span>{reason.length}/500</span>
              </Form>
            </Modal.Content>
            <Modal.Actions>
              <Button disabled={saving} onClick={close}>
                {_(".cancel")}
              </Button>
              <Button primary loading={saving} disabled={saving || reason.length > 500} onClick={save}>
                {_(".confirm")}
              </Button>
            </Modal.Actions>
          </Modal>
        </>
      )}
    </>
  );
});

export default defineRoute(async () => <RegistrationReviewPage />);
