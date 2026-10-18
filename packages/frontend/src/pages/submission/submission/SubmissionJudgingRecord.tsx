import React, { useState } from "react";
import { Accordion, Icon, Popup, Table } from "semantic-ui-react";

import style from "./SubmissionPage.module.less";

import { useLocalizer } from "@/utils/hooks";
import formatFileSize from "@/utils/formatFileSize";
import formatDateTime from "@/utils/formatDateTime";
import StatusText from "@/components/StatusText";
import ScoreText from "@/components/ScoreText";

interface SubmissionJudgingRecordProps {
  dataVersion?: ApiTypes.SubmissionDataVersionDto;
  judgeRuntime?: ApiTypes.SubmissionJudgeRuntimeDto;
  earlierResults?: ApiTypes.SubmissionEarlierResultDto[];
}

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
 * For users who can rejudge the submission: the problem data version it's judged with, what its result was judged
 * with, and the results that rejudges replaced.
 */
const SubmissionJudgingRecord: React.FC<SubmissionJudgingRecordProps> = props => {
  const _ = useLocalizer("submission.judging_record");
  const [open, setOpen] = useState(false);
  const earlier = props.earlierResults || [];
  if (!props.dataVersion && !props.judgeRuntime && earlier.length === 0) return null;

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
