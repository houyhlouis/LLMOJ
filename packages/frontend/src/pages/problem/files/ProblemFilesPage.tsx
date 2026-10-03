import AiProblemPanel from "@/pages/ai/AiProblemPanel";
import React, { useEffect, useState, useRef } from "react";
import {
  Dropdown,
  Grid,
  Icon,
  Header,
  Popup,
  Button,
  Form,
  Checkbox,
  List,
  Table,
  SemanticCOLORS,
  Progress,
  Ref,
  Modal,
  Message
} from "semantic-ui-react";
import { v4 as uuid } from "uuid";
import isEqual from "lodash/isEqual";
import streamsaver from "streamsaver";
import pAll from "p-all";
import { useDebounce } from "use-debounce";

import style from "./ProblemFilesPage.module.less";

import api, { createPostApi } from "@/api";
import { aiText } from "@/pages/ai/api";
import { appState } from "@/appState";
import toast from "@/utils/toast";
import { useAsyncCallbackPending, useLocalizer, useScreenWidthWithin, Link } from "@/utils/hooks";
import getFileIcon from "@/utils/getFileIcon";
import formatFileSize from "@/utils/formatFileSize";
import downloadFile from "@/utils/downloadFile";
import openUploadDialog from "@/utils/openUploadDialog";
import pipeStream from "@/utils/pipeStream";
import { observer } from "mobx-react";
import { defineRoute, RouteError } from "@/AppRouter";
import { callApiWithFileUpload } from "@/utils/callApiWithFileUpload";
import { createZipStream } from "@/utils/zip";
import { getProblemIdString, getProblemUrl } from "../utils";
import { onEnterPress } from "@/utils/onEnterPress";
import { isValidFilename } from "@/utils/validators";
import { Localizer, makeToBeLocalizedText } from "@/locales";
import { EmojiRenderer } from "@/components/EmojiRenderer";

// Firefox have no WritableStream
if (!window.WritableStream || true) {
  (streamsaver as any).WritableStream = (await import("web-streams-polyfill/ponyfill/es6")).WritableStream;
}
// Keep StreamSaver same-origin; HTTP intranet clients use a Blob below because
// service workers are unavailable in an insecure context.
(streamsaver as any).mitm = new URL(`${window.apiEndpoint}api/cors/streamsaver/mitm.html`, location.href).href;

export async function downloadProblemFile(
  problemId: number,
  type: "TestData" | "AdditionalFile",
  filename: string,
  _: Localizer
) {
  if (!filename) return toast.error(_("problem_files.error.NO_SUCH_FILE"));

  const { requestError, response } = await api.problem.downloadProblemFiles({
    problemId,
    type,
    filenameList: [filename]
  });
  if (requestError) return toast.error(requestError(_));
  if (response.error) return toast.error(_(`problem_files.error.${response.error}`));
  if (response.downloadInfo.length === 0) return toast.error(_("problem_files.error.NO_SUCH_FILE"));

  downloadFile(response.downloadInfo[0].downloadUrl);
}

export async function downloadProblemFilesAsArchive(
  problemId: number,
  filename: string,
  type: "TestData" | "AdditionalFile",
  filenames: string[],
  _: Localizer
) {
  const { requestError, response } = await api.problem.downloadProblemFiles({
    problemId,
    type,
    filenameList: filenames
  });
  if (requestError) return toast.error(requestError(_));
  if (response.error) return toast.error(_(`problem_files.error.${response.error}`));

  const { downloadInfo } = response;

  if (downloadInfo.length === 0) return toast.error(_("problem_files.no_files_to_download"));

  let i = 0;
  const zipStream = createZipStream({
    async pull(ctrl) {
      if (i == downloadInfo.length) return ctrl.close();

      try {
        const response = await fetch(downloadInfo[i].downloadUrl);
        if (!response.ok) {
          throw response.statusText;
        }

        ctrl.enqueue({
          name: downloadInfo[i].filename,
          stream: () => response.body
        });
      } catch (e) {
        toast.error(
          _("problem_files.download_as_archive_error", {
            filename: downloadInfo[i].filename,
            error: e.toString()
          })
        );
        throw e;
      }

      i++;
    }
  });

  if (!window.isSecureContext) {
    try {
      const blob = await new Response(zipStream).blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      toast.error(String(error));
    }
    return;
  }

  const fileStream = streamsaver.createWriteStream(filename);
  const abortCallbackReceiver: { abort?: () => void } = {};

  function stopDownload() {
    abortCallbackReceiver.abort?.();
  }

  // If we are on an insecure context, StreamSaver will use a MITM page to download the file
  // a beforeunload event is triggered by the library (not a user), so ignore it
  let isBeforeUnloadTriggeredByLibrary = !window.isSecureContext;
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (isBeforeUnloadTriggeredByLibrary) {
      isBeforeUnloadTriggeredByLibrary = false;
      return;
    }
    e.returnValue = "";
  }

  window.addEventListener("unload", stopDownload);
  window.addEventListener("beforeunload", onBeforeUnload);

  await pipeStream(zipStream, fileStream, abortCallbackReceiver);

  window.removeEventListener("unload", stopDownload);
  window.removeEventListener("beforeunload", onBeforeUnload);
}

const MAX_UPLOAD_CONCURRENCY = 5;

async function fetchData(idType: "id" | "displayId", id: number) {
  const { requestError, response } = await api.problem.getProblem({
    [idType]: id,
    testData: true,
    additionalFiles: true,
    permissionOfCurrentUser: true
  });

  if (requestError) throw new RouteError(requestError, { showRefresh: true, showBack: true });
  else if (response.error) throw new RouteError(makeToBeLocalizedText(`problem_files.error.${response.error}`));

  return response;
}

interface FileUploadInfo {
  file: File;
  progressType: "Waiting" | "Uploading" | "Retrying" | "Requesting" | "Error" | "Cancelled";
  cancel?: () => void;
  progress?: number;
  error?: string;
}

interface FileTableItem {
  uuid: string;
  filename: string;
  size: number;
  upload?: FileUploadInfo;
}

interface FileTableRowProps {
  file: FileTableItem;
  hasPermission: boolean;
  selected: boolean;
  pending: boolean;
  onSelect: (checked: boolean) => void;
  onDownload: () => void;
  onRename: (newFilename: string) => Promise<boolean>;
  onDelete: () => Promise<void>;
}

let FileTableRow: React.FC<FileTableRowProps> = props => {
  const _ = useLocalizer("problem_files");

  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const [newFilename, setNewFilename] = useState(props.file.filename);

  async function onRename() {
    if (await props.onRename(newFilename)) setRenameOpen(false);
  }

  async function onDelete() {
    await props.onDelete();
    setDeleteOpen(false);
  }

  function formatProgress(progress: number) {
    const str = progress.toFixed(1);
    if (str === "100.0") return "100";
    return str;
  }

  const [debouncedUploadProgress, debouncedUploadProgressControlFunctions] = useDebounce(
    (props.file.upload && props.file.upload.progress) || 0,
    24,
    {
      maxWait: 24
    }
  );
  if (props.file.upload && props.file.upload.progress === 100) debouncedUploadProgressControlFunctions.flush();

  function getUploadStatus() {
    const status = (() => {
      switch (props.file.upload.progressType) {
        case "Waiting":
          return (
            <>
              <Icon name="hourglass half" />
              {_(".progress_waiting")}
            </>
          );
        case "Uploading":
          return (
            <>
              <Icon name="cloud upload" />
              {_(".progress_uploading", {
                progress: formatProgress(debouncedUploadProgress)
              })}
            </>
          );
        case "Retrying":
          return (
            <>
              <Icon name="redo" />
              {_(".progress_retrying")}
            </>
          );
        case "Requesting":
          return (
            <>
              <Icon name="spinner" />
              {_(".progress_requesting")}
            </>
          );
        case "Error":
          return (
            <>
              <Icon name="warning sign" />
              {_(".progress_error")}
            </>
          );
        case "Cancelled":
          return (
            <>
              <Icon name="warning circle" />
              {_(".progress_cancelled")}
            </>
          );
      }
    })();

    if (props.file.upload.progressType === "Error") {
      return (
        <>
          <Popup
            trigger={<span>{status}</span>}
            hoverable
            content={props.file.upload.error}
            on="hover"
            position="top center"
          />
        </>
      );
    } else if (props.file.upload.cancel) {
      return (
        <>
          <Popup
            trigger={<span>{status}</span>}
            content={<Button onClick={props.file.upload.cancel}>{_(".cancel_upload")}</Button>}
            on="hover"
            hoverable
            position="top center"
          />
        </>
      );
    }
    return status;
  }

  const isMobile = useScreenWidthWithin(0, 425 + 1);

  return (
    <>
      <Table.Row>
        <Table.Cell className={style.fileTableColumnFilename}>
          {props.file.upload && props.file.upload.progress != null && (
            <Progress percent={debouncedUploadProgress} indicating />
          )}
          <EmojiRenderer>
            <div className={style.filename}>
              <Checkbox
                className={style.fileTableCheckbox}
                checked={props.selected}
                disabled={!!props.file.upload}
                onChange={(e, { checked }) => props.onSelect(checked)}
              />
              <Icon name={getFileIcon(props.file.filename)} />
              {"\u200E" + props.file.filename}
            </div>
          </EmojiRenderer>
        </Table.Cell>
        {!isMobile && <Table.Cell textAlign="center">{formatFileSize(props.file.size, 1)}</Table.Cell>}
        <Table.Cell className={style.fileTableColumnOperations} textAlign="center">
          {props.file.upload ? (
            getUploadStatus()
          ) : (
            <>
              <Icon className={style.fileTableOperationIcon} name="download" onClick={() => props.onDownload()} />
              {props.hasPermission && (
                <>
                  <Popup
                    trigger={
                      <Icon disabled={props.pending} className={style.fileTableOperationIcon} name="pencil alternate" />
                    }
                    disabled={props.pending}
                    open={renameOpen}
                    onOpen={() => setRenameOpen(true)}
                    onClose={() => !props.pending && setRenameOpen(false)}
                    content={
                      <Form>
                        <Form.Input
                          style={{ width: 230 }}
                          placeholder={_(".new_filename")}
                          value={newFilename}
                          onChange={(e, { value }) => setNewFilename(value)}
                          onKeyPress={onEnterPress(() => onRename())}
                        />
                        <Button primary loading={props.pending} onClick={onRename}>
                          {_(".rename")}
                        </Button>
                      </Form>
                    }
                    on="click"
                    position="top center"
                  />
                  <Popup
                    trigger={<Icon disabled={props.pending} className={style.fileTableOperationIcon} name="delete" />}
                    disabled={props.pending}
                    open={deleteOpen}
                    onOpen={() => setDeleteOpen(true)}
                    onClose={() => !props.pending && setDeleteOpen(false)}
                    content={
                      <Button negative loading={props.pending} onClick={onDelete}>
                        {_(".confirm_delete")}
                      </Button>
                    }
                    on="click"
                    position="top center"
                  />
                </>
              )}
            </>
          )}
        </Table.Cell>
      </Table.Row>
    </>
  );
};

FileTableRow = observer(FileTableRow);

interface FileTableProps {
  hasPermission: boolean;
  color: SemanticCOLORS;
  files: FileTableItem[];
  onDownloadFile: (filename: string) => void;
  onDownloadFilesAsArchive: (filenames: string[]) => void;
  onRenameFile: (filename: string, newFilename: string) => Promise<boolean>;
  onDeleteFiles: (filenames: string[]) => Promise<void>;
  onUploadFiles: (files: File[]) => void;
  onUploadArchive?: () => void;
}

let FileTable: React.FC<FileTableProps> = props => {
  const _ = useLocalizer("problem_files");

  const [selectedFiles, setSelectedFiles] = useState(new Set<string>());

  const nonUploadingFiles = props.files.filter(file => !file.upload);
  useEffect(() => {
    const fileUuids = nonUploadingFiles.map(file => file.uuid);
    const newSelectedFiles = new Set<string>();
    for (const fileUuid of selectedFiles) {
      if (fileUuids.includes(fileUuid)) newSelectedFiles.add(fileUuid);
    }

    if (!isEqual(selectedFiles, newSelectedFiles)) setSelectedFiles(newSelectedFiles);
  }, [props.files]);

  function onSelectAll(checked: boolean) {
    setSelectedFiles(new Set(checked ? nonUploadingFiles.map(file => file.uuid) : []));
  }

  function onSelect(fileUuid: string, checked: boolean) {
    const newSelectedFiles = new Set(selectedFiles);
    if (checked) newSelectedFiles.add(fileUuid);
    else newSelectedFiles.delete(fileUuid);
    setSelectedFiles(newSelectedFiles);
  }

  const selectedFilesArray = props.files.filter(file => selectedFiles.has(file.uuid));

  const [pendingFiles, setPendingFiles] = useState(new Set<string>());
  function setPending(fileUuids: string | string[], pending: boolean) {
    const newPendingFiles = new Set(pendingFiles);

    if (typeof fileUuids === "string") fileUuids = [fileUuids];

    for (const fileUuid of fileUuids) {
      if (pending) newPendingFiles.add(fileUuid);
      else newPendingFiles.delete(fileUuid);
    }

    setPendingFiles(newPendingFiles);
  }

  async function onRename(fileUuid: string, filename: string, newFilename: string) {
    if (pendingFiles.has(fileUuid)) return false;
    setPending(fileUuid, true);
    try {
      return await props.onRenameFile(filename, newFilename);
    } finally {
      setPending(fileUuid, false);
    }
  }

  async function onDelete(fileUuids: string[], filenames: string[]) {
    if (fileUuids.some(fileUuid => pendingFiles.has(fileUuid))) return;
    setPending(fileUuids, true);
    await props.onDeleteFiles(filenames);
    setPending(fileUuids, false);
  }

  const uploadingCount = props.files.filter(
    file => file.upload && file.upload.progressType !== "Error" && file.upload.progressType !== "Cancelled"
  ).length;

  const [overridingFiles, setOverridingFiles] = useState<string[]>([]);
  const refDoUpload = useRef<() => void>();
  async function onUploadButtonClick() {
    if (uploadingCount) return;

    openUploadDialog(files => {
      if (files.some(file => !isValidFilename(file.name))) {
        // This shouldn't happen
        toast.error(_(".invalid_filename"));
        return;
      }

      const doUpload = () => props.onUploadFiles(files);

      // Cancelled and Error uploads will not be shown as overriding
      const currentFilenames = props.files.filter(file => !file.upload).map(file => file.filename);
      const overriding = files.map(file => file.name).filter(filename => currentFilenames.includes(filename));
      if (overriding.length > 0) {
        setOverridingFiles(overriding);
        refDoUpload.current = doUpload;
      } else doUpload();
    });
  }

  const [refSelectedInfoDropdown, setRefSelectedInfoDropdown] = useState<HTMLElement>(null);
  const [selectedInfoDropdownOpen, setSelectedInfoDropdownOpen] = useState(false);
  const [popupDeleteSelectedOpen, setPopupDeleteSelectedOpen] = useState(false);
  const [deleteSelectedPending, onDeleteSelected] = useAsyncCallbackPending(async () => {
    await props.onDeleteFiles(selectedFilesArray.map(file => file.filename));
    setPopupDeleteSelectedOpen(false);
  });

  const isMobile = useScreenWidthWithin(0, 425 + 1);

  return (
    <>
      <Table
        compact
        color={props.color}
        className={style.fileTable + (!props.hasPermission ? " " + style.noManagePermission : "")}
        unstackable
      >
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>
              <Checkbox
                className={style.fileTableCheckbox}
                checked={selectedFiles.size > 0}
                indeterminate={selectedFiles.size > 0 && selectedFiles.size < nonUploadingFiles.length}
                disabled={deleteSelectedPending}
                onChange={(e, { checked }) => onSelectAll(checked)}
              />
              {_(".filename")}
            </Table.HeaderCell>
            {!isMobile && (
              <Table.HeaderCell className={style.fileTableColumnSize} textAlign="center">
                {_(".size")}
              </Table.HeaderCell>
            )}
            <Table.HeaderCell textAlign="center" className={style.fileTableColumnOperations}>
              {props.hasPermission ? _(".operations_and_status") : _(".operations")}
            </Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {props.files.length === 0 ? (
            <Table.Row>
              <Table.HeaderCell colSpan={isMobile ? 2 : 3} textAlign="center" className={style.filesTableNoFiles}>
                <Header>{_(".no_files")}</Header>
              </Table.HeaderCell>
            </Table.Row>
          ) : (
            props.files.map(file => (
              <FileTableRow
                key={file.uuid}
                file={file}
                hasPermission={props.hasPermission}
                selected={selectedFiles.has(file.uuid)}
                pending={pendingFiles.has(file.uuid)}
                onSelect={checked => onSelect(file.uuid, checked)}
                onDownload={() => props.onDownloadFile(file.filename)}
                onRename={newFilename => onRename(file.uuid, file.filename, newFilename)}
                onDelete={() => onDelete([file.uuid], [file.filename])}
              />
            ))
          )}
        </Table.Body>
        <Table.Footer fullWidth>
          <Table.Row>
            <Table.HeaderCell colSpan={isMobile ? 2 : 3}>
              <div className={style.fileTableFooterInfo}>
                <div className={style.tableFooterText}>
                  {selectedFilesArray.length > 0 ? (
                    <Ref innerRef={setRefSelectedInfoDropdown}>
                      <Dropdown
                        open={selectedInfoDropdownOpen}
                        onOpen={() => !popupDeleteSelectedOpen && setSelectedInfoDropdownOpen(true)}
                        onClose={() => setSelectedInfoDropdownOpen(false)}
                        pointing
                        text={_(isMobile ? ".selected_files_count_and_size_narrow" : ".selected_files_count_and_size", {
                          count: selectedFilesArray.length.toString(),
                          totalSize: formatFileSize(
                            selectedFilesArray.reduce((sum, file) => sum + file.size, 0),
                            1
                          )
                        })}
                      >
                        <Dropdown.Menu className={style.fileTableSelectedFilesDropdownMenu}>
                          <Dropdown.Item
                            icon="download"
                            text={_(".download_as_archive")}
                            onClick={() =>
                              props.onDownloadFilesAsArchive(selectedFilesArray.map(file => file.filename))
                            }
                          />
                          {props.hasPermission && (
                            <Popup
                              trigger={<Dropdown.Item icon="delete" text={_(".delete")} />}
                              open={popupDeleteSelectedOpen}
                              onOpen={() => setPopupDeleteSelectedOpen(true)}
                              onClose={() => !deleteSelectedPending && setPopupDeleteSelectedOpen(false)}
                              context={refSelectedInfoDropdown}
                              content={
                                <Button negative loading={deleteSelectedPending} onClick={onDeleteSelected}>
                                  {_(".confirm_delete")}
                                </Button>
                              }
                              on="click"
                              position="top center"
                            />
                          )}
                        </Dropdown.Menu>
                      </Dropdown>
                    </Ref>
                  ) : uploadingCount ? (
                    _(
                      isMobile ? ".files_count_and_size_with_uploading_narrow" : ".files_count_and_size_with_uploading",
                      {
                        count: props.files.length.toString(),
                        totalSize: formatFileSize(
                          props.files.reduce((sum, file) => sum + file.size, 0),
                          1
                        ),
                        uploadingCount: uploadingCount.toString()
                      }
                    )
                  ) : (
                    _(isMobile ? ".files_count_and_size_narrow" : ".files_count_and_size", {
                      count: props.files.length.toString(),
                      totalSize: formatFileSize(
                        props.files.reduce((sum, file) => sum + file.size, 0),
                        1
                      )
                    })
                  )}
                </div>
                {props.hasPermission && props.onUploadArchive && (
                  <Button
                    className={style.tableFooterButton}
                    size="small"
                    type="button"
                    onClick={props.onUploadArchive}
                  >
                    {aiText("上传 ZIP", "Upload ZIP")}
                  </Button>
                )}
                {props.hasPermission && (
                  <Popup
                    trigger={
                      <Button
                        className={style.tableFooterButton}
                        icon="upload"
                        content={_(".upload")}
                        labelPosition="left"
                        primary
                        size={"small"}
                        loading={uploadingCount !== 0}
                        onClick={onUploadButtonClick}
                      />
                    }
                    open={overridingFiles.length !== 0}
                    onClose={() => setOverridingFiles([])}
                    content={
                      <>
                        <p>
                          <strong>{_(".confirm_override_question")}</strong>
                        </p>
                        <List>
                          {overridingFiles.map(filename => (
                            <EmojiRenderer key={filename}>
                              <List.Item icon={getFileIcon(filename)} content={filename} />
                            </EmojiRenderer>
                          ))}
                        </List>
                        <Ref innerRef={button => button && window.requestAnimationFrame(() => button.focus())}>
                          <Button
                            onClick={() => {
                              setOverridingFiles([]);
                              refDoUpload.current();
                            }}
                          >
                            {_(".confirm_override")}
                          </Button>
                        </Ref>
                      </>
                    }
                    on="click"
                    position="left center"
                  />
                )}
              </div>
            </Table.HeaderCell>
          </Table.Row>
        </Table.Footer>
      </Table>
    </>
  );
};

FileTable = observer(FileTable);

interface ProblemFilesPageProps {
  idType?: "id" | "displayId";
  problem?: ApiTypes.GetProblemResponseDto;
}

let ProblemFilesPage: React.FC<ProblemFilesPageProps> = props => {
  const _ = useLocalizer("problem_files");

  const idString = getProblemIdString(props.problem.meta);

  useEffect(() => {
    appState.enterNewPage(`${_(".title")} ${idString}`, "problem_set");
  }, [appState.locale, props.problem]);

  function transformResponseToFileTableItems(fileList: ApiTypes.ProblemFileDto[]): FileTableItem[] {
    return fileList.map(file => ({
      uuid: uuid(),
      filename: file.filename,
      size: file.size
    }));
  }

  const [fileListTestData, setFileListTestData] = useState(transformResponseToFileTableItems(props.problem.testData));
  const [fileListAdditionalFiles, setFileListAdditionalFiles] = useState(
    transformResponseToFileTableItems(props.problem.additionalFiles)
  );

  const [archive, setArchive] = useState<File>(null),
    [replaceExisting, setReplaceExisting] = useState(false),
    [archivePending, setArchivePending] = useState(false),
    [archiveProgress, setArchiveProgress] = useState(0),
    [archivePhase, setArchivePhase] = useState(""),
    [archiveError, setArchiveError] = useState("");

  function selectArchive() {
    openUploadDialog(files => {
      if (!files.length) return;
      if (files.length !== 1 || !/\.zip$/i.test(files[0].name)) {
        toast.error(aiText("请选择一个 ZIP 压缩包。", "Select one ZIP archive."));
        return;
      }
      if (files[0].size > 8 * 1024 ** 3) {
        toast.error(aiText("ZIP 压缩包不能超过 8 GiB。", "ZIP archives must not exceed 8 GiB."));
        return;
      }
      setArchive(files[0]);
      setReplaceExisting(false);
      setArchiveError("");
    }, ".zip,application/zip");
  }

  async function uploadArchive() {
    if (!archive || archivePending) return;
    setArchivePending(true);
    setArchiveError("");
    try {
      const result = await callApiWithFileUpload<any, any>({
        api: createPostApi<any, any>("problem/importTestDataZip", { proofOfWorkAction: "add_problem_file" }),
        request: { problemId: props.problem.meta.id, filename: archive.name, replaceExisting },
        file: archive,
        onProgress: progress => {
          setArchiveProgress(Math.round(progress.progress * 100));
          setArchivePhase(progress.status);
        }
      });
      if (result.requestError) throw new Error(result.requestError(_));
      if (result.uploadError || result.uploadCancelled)
        throw new Error(aiText("压缩包上传失败，请重试。", "Archive upload failed. Please retry."));
      if (!result.response || result.response.error) {
        const code = result.response?.error || "UNKNOWN";
        const errors: Record<string, [string, string]> = {
          FILE_ALREADY_EXISTS: [
            "存在同名文件；如需替换，请勾选替换选项。",
            "Files already exist. Select the replacement option to overwrite them."
          ],
          ZIP_FILENAME_CONFLICT: [
            "压缩包内存在会重名的文件，请重命名后重试。",
            "Archive filenames conflict after extraction. Rename them and retry."
          ],
          AMBIGUOUS_ZIP_PAIR: [
            "测试点输入输出配对不唯一，请检查 .out 和 .ans 文件。",
            "Test case pairing is ambiguous. Check the .out and .ans files."
          ],
          ZIP_INTEGRITY_ERROR: ["压缩包已损坏或校验失败。", "The archive is corrupt or failed its integrity check."],
          ZIP_INSUFFICIENT_STORAGE: ["服务器可用存储空间不足。", "The server has insufficient storage space."],
          ZIP_TIMEOUT: [
            "解压超时，请分成较小的压缩包。",
            "Extraction timed out. Split the archive into smaller files."
          ],
          UNSUPPORTED_ZIP: [
            "不支持此 ZIP 格式，请勿加密压缩包。",
            "This ZIP format is unsupported. Do not encrypt the archive."
          ],
          UNSAFE_ZIP_PATH: ["压缩包包含不安全的路径。", "The archive contains unsafe paths."],
          UNSAFE_ZIP_ENTRY: ["压缩包包含不支持的特殊文件。", "The archive contains unsupported special files."],
          DUPLICATE_ZIP_PATH: ["压缩包存在重复路径。", "The archive contains duplicate paths."],
          INVALID_ZIP_FILENAME: ["压缩包内的文件名无效。", "An archive filename is invalid."],
          INVALID_ZIP: ["无效的 ZIP 压缩包。", "Invalid ZIP archive."]
        };
        const limits = [
          "ZIP_SIZE_LIMIT",
          "ZIP_DIRECTORY_LIMIT",
          "ZIP_FILE_SIZE_LIMIT",
          "ZIP_FILE_COUNT_LIMIT",
          "ZIP_TOTAL_SIZE_LIMIT",
          "ZIP_EXPANSION_LIMIT"
        ];
        const detail = limits.includes(code)
          ? aiText(
              "压缩包超出大小或数量限制：最多 4096 个文件，单文件 256 MiB，压缩包及展开总量 8 GiB，且不能超过题目剩余配额。",
              "Archive limits exceeded: up to 4,096 files, 256 MiB per file, and 8 GiB compressed / extracted, within the problem's remaining quota."
            )
          : errors[code]
          ? aiText(...errors[code])
          : _(`.error.${code}`);
        throw new Error(detail);
      }
      const imported = transformResponseToFileTableItems(result.response.importedFiles || []);
      setFileListTestData(current =>
        current.filter(file => !imported.some(next => next.filename === file.filename)).concat(imported)
      );
      toast.success(aiText(`已导入 ${imported.length} 个文件。`, `Imported ${imported.length} files.`));
      setArchive(null);
    } catch (e) {
      setArchiveError(e.message);
    } finally {
      setArchivePending(false);
      setArchiveProgress(0);
    }
  }

  async function onRenameFile(
    type: "TestData" | "AdditionalFile",
    setFileList: typeof setFileListTestData,
    filename: string,
    newFilename: string
  ) {
    if (!isValidFilename(newFilename)) {
      toast.error(_(".invalid_filename"));
      return false;
    }

    const { requestError, response } = await api.problem.renameProblemFile({
      problemId: props.problem.meta.id,
      type,
      filename,
      newFilename
    });
    if (requestError) {
      toast.error(requestError(_));
      return false;
    }

    if (response.error) {
      toast.error(_(`.error.${response.error}`));
      return false;
    }

    // Unpack state object later to prevent from using a dirty value
    setFileList(fileList =>
      fileList.map(file =>
        file.filename !== filename
          ? file
          : Object.assign({}, file, {
              filename: newFilename
            })
      )
    );
    return true;
  }

  async function onDeleteFiles(
    type: "TestData" | "AdditionalFile",
    setFileList: typeof setFileListTestData,
    filenames: string[]
  ) {
    const { requestError, response } = await api.problem.removeProblemFiles({
      problemId: props.problem.meta.id,
      type,
      filenames: filenames
    });
    if (requestError) {
      toast.error(requestError(_));
      return;
    }

    if (response.error) {
      toast.error(_(`.error.${response.error}`));
      return;
    }

    // Unpack state object later to prevent from using a dirty value
    setFileList(fileList => fileList.filter(file => !filenames.includes(file.filename)));
  }

  async function onUploadFiles(
    type: "TestData" | "AdditionalFile",
    fileList: typeof fileListTestData,
    setFileList: typeof setFileListTestData,
    files: File[]
  ) {
    const uploadingFilenames = files.map(file => file.name);
    const uploadingFileList: FileTableItem[] = [];
    for (const file of files) {
      uploadingFileList.push({
        uuid: uuid(),
        filename: file.name,
        size: file.size,
        upload: {
          file: file,
          progressType: "Waiting"
        }
      });
    }
    const newFileList = fileList.filter(file => !uploadingFilenames.includes(file.filename)).concat(uploadingFileList);
    setFileList(newFileList);

    function updateFileUploadInfo(fileUuid: string, uploadInfo: Partial<FileUploadInfo>) {
      setFileList(fileList => {
        const newFileList = Array.from(fileList);
        for (const i in newFileList) {
          if (newFileList[i].uuid === fileUuid) {
            newFileList[i] = Object.assign({}, fileList[i], {
              upload: uploadInfo ? Object.assign({}, fileList[i].upload, uploadInfo) : null
            });
            return newFileList;
          }
        }
        return fileList;
      });
    }

    const uploadTasks: Array<() => Promise<void>> = [];
    for (const item of uploadingFileList) {
      uploadTasks.push(async () => {
        const { uploadCancelled, uploadError, requestError, response } = await callApiWithFileUpload({
          api: api.problem.addProblemFile,
          request: {
            problemId: props.problem.meta.id,
            type,
            filename: item.filename
          },
          file: item.upload.file,
          onProgress: progress =>
            updateFileUploadInfo(item.uuid, {
              progressType: progress.status,
              progress: progress.progress * 100
            }),
          onCancelAvailable: cancelFunction =>
            updateFileUploadInfo(item.uuid, {
              cancel: cancelFunction
            })
        });

        if (uploadCancelled) {
          updateFileUploadInfo(item.uuid, {
            progressType: "Cancelled",
            cancel: null
          });
        } else if (uploadError) {
          console.log("Error uploading file", uploadError);
          updateFileUploadInfo(item.uuid, {
            progressType: "Error",
            error: String(uploadError)
          });
        } else if (requestError) {
          updateFileUploadInfo(item.uuid, {
            progressType: "Error",
            error: requestError(_)
          });
        } else if (response.error) {
          updateFileUploadInfo(item.uuid, {
            progressType: "Error",
            error: _(`.error.${response.error}`)
          });
        } else updateFileUploadInfo(item.uuid, null);
      });
    }

    await pAll(uploadTasks, {
      concurrency: MAX_UPLOAD_CONCURRENCY
    });
  }

  const isWideScreen = useScreenWidthWithin(960, Infinity);

  const fileTableTestdata = (
    <>
      <Header
        className={style.header + " withIcon"}
        icon="file alternate"
        as="h2"
        content={
          <>
            {_(".header_testdata")}
            <Button
              className={style.backToProblem}
              primary
              as={Link}
              href={getProblemUrl(props.problem.meta)}
              content={_(".back_to_problem")}
            />
          </>
        }
      />
      <FileTable
        hasPermission={props.problem.permissionOfCurrentUser.includes("Modify")}
        color="green"
        files={fileListTestData}
        onDownloadFile={filename => downloadProblemFile(props.problem.meta.id, "TestData", filename, _)}
        onDownloadFilesAsArchive={filenames =>
          downloadProblemFilesAsArchive(props.problem.meta.id, `TestData_${idString}.zip`, "TestData", filenames, _)
        }
        onRenameFile={(filename, newFilename) => onRenameFile("TestData", setFileListTestData, filename, newFilename)}
        onDeleteFiles={filenames => onDeleteFiles("TestData", setFileListTestData, filenames)}
        onUploadFiles={files => onUploadFiles("TestData", fileListTestData, setFileListTestData, files)}
        onUploadArchive={selectArchive}
      />
    </>
  );

  const fileTableAdditionalFile = (
    <>
      <Header
        className={style.header + " withIcon"}
        icon="file alternate outline"
        as="h2"
        content={_(".header_additional_files")}
      />
      <FileTable
        hasPermission={props.problem.permissionOfCurrentUser.includes("Modify")}
        color="pink"
        files={fileListAdditionalFiles}
        onDownloadFile={filename => downloadProblemFile(props.problem.meta.id, "AdditionalFile", filename, _)}
        onDownloadFilesAsArchive={filenames =>
          downloadProblemFilesAsArchive(
            props.problem.meta.id,
            `AdditionalFile_${idString}.zip`,
            "AdditionalFile",
            filenames,
            _
          )
        }
        onRenameFile={(filename, newFilename) =>
          onRenameFile("AdditionalFile", setFileListAdditionalFiles, filename, newFilename)
        }
        onDeleteFiles={filenames => onDeleteFiles("AdditionalFile", setFileListAdditionalFiles, filenames)}
        onUploadFiles={files =>
          onUploadFiles("AdditionalFile", fileListAdditionalFiles, setFileListAdditionalFiles, files)
        }
      />
    </>
  );

  return (
    <>
      <Modal
        open={!!archive}
        size="small"
        closeOnDimmerClick={!archivePending}
        closeOnEscape={!archivePending}
        onClose={() => !archivePending && setArchive(null)}
      >
        <Modal.Header>{aiText("导入测试数据 ZIP", "Import test data ZIP")}</Modal.Header>
        <Modal.Content>
          <p>{archive?.name}</p>
          <p>
            {aiText(
              "上传打包好的 .in 和 .out / .ans 文件。系统会展开文件夹并自动配对测试点；同名文件默认不覆盖。导入后可在评测设置中配置子任务和分值。",
              "Upload paired .in and .out / .ans files. Folders are unpacked and test cases paired automatically; existing files are kept by default. Configure subtasks and scores in Judge settings after import."
            )}
          </p>
          <Form.Checkbox
            label={aiText("替换已有同名文件", "Replace existing files with matching names")}
            checked={replaceExisting}
            disabled={archivePending}
            onChange={(_e, value) => setReplaceExisting(!!value.checked)}
          />
          {archivePending && (
            <Progress
              active
              percent={archiveProgress}
              progress={archivePhase === "Uploading"}
              label={
                archivePhase === "Uploading"
                  ? aiText("上传中", "Uploading")
                  : aiText("正在处理压缩包", "Processing archive")
              }
            />
          )}
          {archiveError && <Message negative>{archiveError}</Message>}
        </Modal.Content>
        <Modal.Actions>
          <Button disabled={archivePending} onClick={() => setArchive(null)}>
            {aiText("取消", "Cancel")}
          </Button>
          <Button primary loading={archivePending} disabled={archivePending} onClick={uploadArchive}>
            {aiText("上传并导入", "Upload and import")}
          </Button>
        </Modal.Actions>
      </Modal>
      {props.problem.permissionOfCurrentUser.includes("Modify") && (
        <AiProblemPanel
          problemId={props.problem.meta.id}
          problemType={props.problem.meta.type}
          onCompleted={() => location.reload()}
        />
      )}
      <Grid>
        {isWideScreen ? (
          <>
            <Grid.Row>
              <Grid.Column width={8}>{fileTableTestdata}</Grid.Column>
              <Grid.Column width={8}>{fileTableAdditionalFile}</Grid.Column>
            </Grid.Row>
          </>
        ) : (
          <>
            <Grid.Row>
              <Grid.Column width={16}>{fileTableTestdata}</Grid.Column>
            </Grid.Row>
            <Grid.Row>
              <Grid.Column width={16}>{fileTableAdditionalFile}</Grid.Column>
            </Grid.Row>
          </>
        )}
      </Grid>
    </>
  );
};

ProblemFilesPage = observer(ProblemFilesPage);

export default {
  byId: defineRoute(async request => {
    const id = parseInt(request.params["id"]);
    const problem = await fetchData("id", id);

    return <ProblemFilesPage key={uuid()} idType="id" problem={problem} />;
  }),
  byDisplayId: defineRoute(async request => {
    const displayId = parseInt(request.params["displayId"]);
    const problem = await fetchData("displayId", displayId);

    return <ProblemFilesPage key={uuid()} idType="displayId" problem={problem} />;
  })
};
