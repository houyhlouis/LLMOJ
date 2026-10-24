import React, { useState } from "react";
import { Accordion, Button, Icon, Popup, Table } from "semantic-ui-react";

import style from "./SubmissionPage.module.less";

import api from "@/api";
import { useLocalizer } from "@/utils/hooks";
import formatFileSize from "@/utils/formatFileSize";
import formatDateTime from "@/utils/formatDateTime";
import toast from "@/utils/toast";
import StatusText from "@/components/StatusText";
import ScoreText from "@/components/ScoreText";

interface SubmissionJudgingRecordProps {
  problemId: number;
  dataVersion?: ApiTypes.SubmissionDataVersionDto;
  judgeRuntime?: ApiTypes.SubmissionJudgeRuntimeDto;
  earlierResults?: ApiTypes.SubmissionEarlierResultDto[];
}

type TestData = ApiTypes.TestDataAvailabilityDto;

/**
 * Whether a data version's test data is all still there, so its results can be judged again with the same data: a
 * version number alone doesn't say. The reasons it's kept are in a popup.
 */
const TestDataState: React.FC<{ testData: TestData; compact?: boolean }> = props => {
  const _ = useLocalizer("submission.judging_record.test_data");
  const { testData, compact } = props;
  const kept = testData.keptAt ? _(".kept_by", { username: testData.keptBy ?? _(".deleted_user") }) : null;
  let text: string;
  let className = style.testDataKept;
  if (testData.state === "Deleted") {
    text = compact ? _(".deleted_short") : _(".deleted");
    className = style.testDataDeleted;
  } else if (testData.state === "InUse") text = kept;
  else if (testData.deletionDue) {
    text = compact ? _(".deletion_due_short") : _(".deletion_due");
    className = style.testDataDeleted;
  } else if (testData.retainedUntil)
    text = _(compact ? ".retained_until_short" : ".retained_until", {
      date: formatDateTime(testData.retainedUntil, true)[1]
    });
  else text = compact ? _(".retained_short") : _(".retained");
  if (!text) return null;
  const reasons = (testData.reasons || []).map(reason => _(`.reasons.${reason}`));
  const details = [testData.state === "Deleted" ? _(".deleted_notes") : null, ...reasons, kept].filter(x => x);
  const label = (
    <span className={className + (details.length > 0 ? " " + style.testDataHelp : "")}>
      {text}
      {testData.state === "Retained" && kept && !compact && ` · ${kept}`}
    </span>
  );
  return details.length > 0 ? (
    <Popup
      on="hover"
      position="bottom left"
      trigger={label}
      content={
        <>
          {testData.state === "Retained" && <p>{_(".kept_because")}</p>}
          <ul className={style.testDataReasons}>
            {details.map(detail => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        </>
      }
    />
  ) : (
    label
  );
};

/** Keeps a data version's test data until released, or releases it, for people who can manage the problem. */
const KeepTestData: React.FC<{
  version: number;
  testData: TestData;
  pending: boolean;
  onClick: (keep: boolean) => void;
}> = props => {
  const _ = useLocalizer("submission.judging_record.test_data");
  if (props.testData.state === "Deleted" && !props.testData.keptAt) return null;
  const keep = !props.testData.keptAt;
  return (
    <Button
      basic
      size="mini"
      compact
      className={style.keepTestData}
      loading={props.pending}
      disabled={props.pending}
      title={keep ? _(".keep_notes", { version: String(props.version) }) : _(".release_notes")}
      onClick={() => props.onClick(keep)}
    >
      {keep ? _(".keep") : _(".release")}
    </Button>
  );
};

// Digests are told apart by their first characters
const shortDigest = (digest: string) => digest.slice(0, 12);

/** What a result was judged with, in a line; its details in a popup. */
const JudgeRuntime: React.FC<{ runtime: ApiTypes.SubmissionJudgeRuntimeDto; compact?: boolean }> = props => {
  const _ = useLocalizer("submission.judging_record");
  const { runtime } = props;
  const machine = runtime.judgeMachine ?? _(".deleted_judge_machine");
  const details: [string, string][] = [
    [_(".judge_machine"), machine],
    [_(".judge_program"), runtime.judgeProgram],
    [_(".sandbox_image"), runtime.sandboxImage],
    ["Node.js", runtime.node],
    [_(".host"), [runtime.os, runtime.kernel, runtime.arch].filter(x => x).join(", ")],
    [_(".cpu"), runtime.cpu]
  ];
  return (
    <Popup
      on="click"
      wide="very"
      position="bottom left"
      trigger={
        <span className={style.judgeRuntimeTrigger}>
          {props.compact
            ? `${machine} · ${shortDigest(runtime.judgeProgram)}`
            : _(".judged_with", {
                machine,
                program: shortDigest(runtime.judgeProgram),
                image: shortDigest(runtime.sandboxImage)
              })}
        </span>
      }
      content={
        <table className={style.judgeRuntimeDetails}>
          <tbody>
            {details.map(([name, value]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
};

/**
 * For users who can rejudge the submission: the problem data version it's judged with and whether its test data is
 * still there, what its result was judged with, and the results that rejudges replaced.
 */
const SubmissionJudgingRecord: React.FC<SubmissionJudgingRecordProps> = props => {
  const _ = useLocalizer("submission.judging_record");
  const [open, setOpen] = useState(false);
  // Availability by version number, as changed by keeping or releasing here
  const [changed, setChanged] = useState<Record<number, TestData>>({});
  // The version being kept or released
  const [pending, setPending] = useState<number>(null);
  const earlier = props.earlierResults || [];
  if (!props.dataVersion && !props.judgeRuntime && earlier.length === 0) return null;
  const testDataOf = (version: number, testData: TestData) => changed[version] ?? testData;

  async function setKept(version: number, keep: boolean) {
    if (pending != null) return;
    setPending(version);
    const { requestError, response } = await api.problem.setTestDataKept({ problemId: props.problemId, version, keep });
    setPending(null);
    if (requestError) toast.error(requestError(_));
    else if (response.error) toast.error(_(`.test_data.errors.${response.error}`));
    else {
      setChanged(previous => ({ ...previous, [version]: response.testData }));
      toast.success(keep ? _(".test_data.kept") : _(".test_data.released"));
    }
  }
  const keepButton = (version: number, testData: TestData) => (
    <KeepTestData
      version={version}
      testData={testDataOf(version, testData)}
      pending={pending === version}
      onClick={keep => setKept(version, keep)}
    />
  );

  return (
    <div className={style.judgingRecord}>
      {props.dataVersion && (
        <p className={style.dataVersion}>
          <Icon name="database" />
          {_(".data_version", { version: String(props.dataVersion.version) })}
          {props.dataVersion.current ? (
            <span className={style.dataVersionCurrent}>{_(".current")}</span>
          ) : (
            <span className={style.dataVersionChanged} title={_(".changed_notes")}>
              {_(".changed")}
            </span>
          )}
          {props.dataVersion.testData && (
            <>
              {" "}
              <TestDataState testData={testDataOf(props.dataVersion.version, props.dataVersion.testData)} />
              {(!props.dataVersion.current || props.dataVersion.testData.keptAt) &&
                keepButton(props.dataVersion.version, props.dataVersion.testData)}
            </>
          )}
        </p>
      )}
      {props.judgeRuntime && (
        <p className={style.dataVersion}>
          <Icon name="server" />
          <JudgeRuntime runtime={props.judgeRuntime} />
        </p>
      )}
      {earlier.length > 0 && (
        <Accordion>
          <Accordion.Title active={open} onClick={() => setOpen(!open)}>
            <Icon name="dropdown" />
            {_(".earlier_results", { count: String(earlier.length) })}
          </Accordion.Title>
          <Accordion.Content active={open}>
            <Table compact unstackable basic="very" textAlign="center">
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{_(".replaced_at")}</Table.HeaderCell>
                  <Table.HeaderCell>{_(".status")}</Table.HeaderCell>
                  <Table.HeaderCell>{_(".score")}</Table.HeaderCell>
                  <Table.HeaderCell>{_(".time")}</Table.HeaderCell>
                  <Table.HeaderCell>{_(".memory")}</Table.HeaderCell>
                  <Table.HeaderCell>{_(".data_version_column")}</Table.HeaderCell>
                  <Table.HeaderCell>{_(".judged_with_column")}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {earlier.map((result, i) => (
                  <Table.Row key={i}>
                    <Table.Cell title={formatDateTime(result.replacedAt)[1]}>
                      {formatDateTime(result.replacedAt)[0]}
                    </Table.Cell>
                    <Table.Cell>
                      <StatusText status={result.status} />
                    </Table.Cell>
                    <Table.Cell>{result.score == null ? "-" : <ScoreText score={result.score} />}</Table.Cell>
                    <Table.Cell>{result.timeUsed == null ? "-" : `${result.timeUsed} ms`}</Table.Cell>
                    <Table.Cell>
                      {result.memoryUsed == null ? "-" : formatFileSize(result.memoryUsed * 1024, 1)}
                    </Table.Cell>
                    <Table.Cell>
                      {result.dataVersion == null ? _(".not_recorded") : `#${result.dataVersion}`}
                      {result.dataVersion != null && result.testData && (
                        <>
                          {" "}
                          <TestDataState testData={testDataOf(result.dataVersion, result.testData)} compact />
                          {result.dataVersion !== props.dataVersion?.version &&
                            keepButton(result.dataVersion, result.testData)}
                        </>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {result.judgeRuntime ? (
                        <JudgeRuntime runtime={result.judgeRuntime} compact />
                      ) : (
                        _(".not_recorded")
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </Accordion.Content>
        </Accordion>
      )}
    </div>
  );
};

export default SubmissionJudgingRecord;
