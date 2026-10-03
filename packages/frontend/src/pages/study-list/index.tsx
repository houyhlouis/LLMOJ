import React, { useEffect, useState } from "react";
import { mount } from "navi";
import { observer } from "mobx-react";
import {
  Header,
  Icon,
  Segment,
  Table,
  Button,
  Form,
  Message,
  Progress,
  Checkbox,
  Modal,
  Label,
  Search,
  Loader
} from "semantic-ui-react";
import { defineRoute, RouteError } from "@/AppRouter";
import { appState } from "@/appState";
import { Link, useNavigationChecked, useScreenWidthWithin, useLocalizer } from "@/utils/hooks";
import { extensionApi } from "@/utils/extensionApi";
import MarkdownContent from "@/markdown/MarkdownContent";
import formatDateTime from "@/utils/formatDateTime";
import ProblemSearch from "@/components/ProblemSearch";
import DifficultyRating from "@/components/DifficultyRating";
import { StatusIcon } from "@/components/StatusText";
import { EmojiRenderer } from "@/components/EmojiRenderer";
import { getProblemDisplayName, getProblemIdString, getProblemUrl } from "@/pages/problem/utils";
import problemSetStyle from "@/pages/problem/problem-set/ProblemSetPage.module.less";
import style from "./StudyListPage.module.less";

const empty = () => ({ title: "", description: "", items: [], starred: false, archived: false });
const StudyLists = observer(({ id }: { id?: number | "new" }) => {
  const zh = appState.locale === "zh_CN",
    t = (a: string, b: string) => (zh ? a : b);
  const nav = useNavigationChecked();
  const _ = useLocalizer("problem_set");
  const isMobileOrPad = useScreenWidthWithin(0, 1024);
  const privateDescription = t("所有题单仅对创建者本人可见。", "Every study list is visible only to its owner.");
  const [lists, setLists] = useState<any[]>([]),
    [list, setList] = useState<any>(empty),
    [details, setDetails] = useState<any[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(id === "new"),
    [preview, setPreview] = useState(false);
  const [filter, setFilter] = useState(""),
    [showArchived, setShowArchived] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  async function load() {
    setError("");
    setBusy(true);
    try {
      if (!id) setLists((await extensionApi("studyList/list")).lists);
      else if (id === "new") {
        setList(empty());
        setDetails([]);
        setEditing(true);
      } else {
        const result = await extensionApi("studyList/get", { id });
        setList(result.list);
        setDetails(result.details);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    appState.enterNewPage(t("题单", "Study Lists"), "study_lists");
    load();
  }, [id, appState.locale]);
  const modify = (key: string, value: any) => setList({ ...list, [key]: value });
  const changeItem = (index: number, value: any) =>
    modify(
      "items",
      list.items.map((item, i) => (i === index ? { ...item, ...value } : item))
    );
  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await extensionApi("studyList/save", {
        id: list.id,
        version: list.version,
        title: list.title,
        description: list.description,
        items: list.items,
        starred: list.starred,
        archived: list.archived
      });
      setList(result.list);
      setDetails(result.details);
      setEditing(false);
      if (id === "new") nav.navigate(`/study-lists/${result.list.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const completed = details.filter(x => x.accepted).length;
  const visibleLists = lists.filter(
    x => (showArchived || !x.archived) && x.title.toLowerCase().includes(filter.toLowerCase())
  );
  const headerSearch = (
    <Search
      className={problemSetStyle.search}
      placeholder={t("搜索题单", "Search lists")}
      value={filter}
      open={false}
      showNoResults={false}
      input={{ fluid: isMobileOrPad, "aria-label": t("搜索题单", "Search lists") }}
      onSearchChange={(_, x) => setFilter(x.value)}
    />
  );
  const headerArchive = (
    <Checkbox
      toggle
      label={t("显示已归档", "Show archived")}
      checked={showArchived}
      onChange={(_, x) => setShowArchived(x.checked)}
    />
  );
  const headerButtons = (
    <div className={problemSetStyle.headerButtons}>
      <Button
        as={Link}
        href="/study-lists/new"
        className="labeled icon"
        icon="plus"
        content={t("新建题单", "New study list")}
        title={privateDescription}
      />
    </div>
  );
  return (
    <>
      {error && <Message negative content={error} />}
      {!appState.currentUser ? (
        <Button as={Link} href="/login" primary>
          {t("登录", "Sign in")}
        </Button>
      ) : !id ? (
        <>
          {isMobileOrPad ? (
            <>
              <div className={problemSetStyle.headerSearchRow}>{headerSearch}</div>
              <div className={problemSetStyle.headerControlRow}>
                {headerArchive}
                {headerButtons}
              </div>
            </>
          ) : (
            <div className={problemSetStyle.headerRow}>
              {headerSearch}
              <div className={problemSetStyle.headerRightControls}>
                {headerArchive}
                {headerButtons}
              </div>
            </div>
          )}
          {busy ? (
            <Loader active inline="centered" />
          ) : visibleLists.length ? (
            <div className={problemSetStyle.tableContainer}>
              <Table basic="very" textAlign="center" unstackable>
                <Table.Header>
                  <Table.Row className={problemSetStyle.tableHeaderRow}>
                    <Table.HeaderCell width={1}>#</Table.HeaderCell>
                    <Table.HeaderCell textAlign="left" title={privateDescription}>
                      {t("题单", "List")}
                    </Table.HeaderCell>
                    <Table.HeaderCell width={1}>{t("题目数", "Problems")}</Table.HeaderCell>
                    <Table.HeaderCell width={1}>{t("更新时间", "Updated")}</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {visibleLists.map(x => (
                    <Table.Row key={x.id} className={problemSetStyle.row}>
                      <Table.Cell>
                        <b>{x.id}</b>
                      </Table.Cell>
                      <Table.Cell textAlign="left" className={`${problemSetStyle.problemTitleCell} ${style.titleCell}`}>
                        <EmojiRenderer>
                          <Link href={`/study-lists/${x.id}`}>
                            {x.starred && <Icon name="star" color="yellow" title={t("已收藏", "Starred")} />}
                            {x.title}
                          </Link>
                        </EmojiRenderer>
                        {x.archived && (
                          <Label size="small" className={problemSetStyle.labelNonPublic}>
                            {t("已归档", "Archived")}
                          </Label>
                        )}
                      </Table.Cell>
                      <Table.Cell textAlign="center">{x.count}</Table.Cell>
                      <Table.Cell className={style.updatedCell}>
                        {isMobileOrPad ? (
                          <span title={formatDateTime(x.updatedAt)[1]}>{formatDateTime(x.updatedAt)[0]}</span>
                        ) : (
                          formatDateTime(x.updatedAt)[1]
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          ) : (
            <Segment placeholder>
              <Header icon>
                <Icon name={lists.length ? "search" : "list alternate outline"} />
                {lists.length ? t("找不到符合条件的题单", "No matching study lists") : t("暂无题单", "No study lists")}
              </Header>
              <Segment.Inline>
                {lists.length ? (
                  <Button
                    onClick={() => {
                      setFilter("");
                      setShowArchived(true);
                    }}
                  >
                    {t("清除搜索条件", "Clear Query")}
                  </Button>
                ) : (
                  <Button primary as={Link} href="/study-lists/new">
                    {t("创建题单", "Create")}
                  </Button>
                )}
              </Segment.Inline>
            </Segment>
          )}
        </>
      ) : (
        <>
          <div className={`${problemSetStyle.headerRow} ${style.detailHeader}`}>
            <Header as="h2">
              {editing
                ? id === "new"
                  ? t("新建题单", "New Study List")
                  : t("编辑题单", "Edit Study List")
                : list.title || t("私人题单", "Private Study List")}
            </Header>
            <div className={style.actions}>
              <Button as={Link} href="/study-lists" disabled={busy} content={t("全部题单", "All study lists")} />
              {editing ? (
                <Button primary loading={busy} onClick={save} content={t("保存", "Save")} />
              ) : (
                <>
                  <Button
                    icon="edit"
                    labeled="left"
                    disabled={busy || !list.id}
                    onClick={() => setEditing(true)}
                    content={t("编辑题单", "Edit study list")}
                  />
                  {list.id && (
                    <Button
                      basic
                      negative
                      disabled={busy}
                      onClick={() => setConfirmDelete(true)}
                      content={t("删除题单", "Delete study list")}
                    />
                  )}
                </>
              )}
            </div>
          </div>
          <div className={style.content} aria-busy={busy}>
            {busy && <Loader active inline="centered" />}
            {editing ? (
              <Form onSubmit={event => event.preventDefault()}>
                <Form.Input
                  label={t("名称", "Title")}
                  title={privateDescription}
                  maxLength={160}
                  value={list.title}
                  onChange={(_, x) => modify("title", x.value)}
                />
                <Form.Checkbox
                  label={t("收藏", "Starred")}
                  checked={list.starred}
                  onChange={(_, x) => modify("starred", x.checked)}
                />
                <Form.Checkbox
                  label={t("归档", "Archived")}
                  checked={list.archived}
                  onChange={(_, x) => modify("archived", x.checked)}
                />
                <Form.TextArea
                  label={t("介绍（Markdown / LaTeX）", "Description (Markdown / LaTeX)")}
                  rows={6}
                  maxLength={200000}
                  value={list.description}
                  onChange={(_, x) => modify("description", x.value)}
                />
                <Button type="button" basic onClick={() => setPreview(!preview)}>
                  {t("预览", "Preview")}
                </Button>
                {preview && <MarkdownContent content={list.description} />}
                <Header as="h3">{t("添加题目", "Add a problem")}</Header>
                <ProblemSearch
                  className={problemSetStyle.search}
                  onResultSelect={problem => {
                    if (!list.items.some(x => x.problemId === problem.meta.id)) {
                      modify("items", [...list.items, { problemId: problem.meta.id, section: "", note: "" }]);
                      setDetails([
                        ...details,
                        {
                          problemId: problem.meta.id,
                          meta: problem.meta,
                          titles: { zh_CN: problem.title, en_US: problem.title }
                        }
                      ]);
                    }
                  }}
                />
              </Form>
            ) : (
              <>
                <div className={style.labels}>
                  <Label basic title={privateDescription}>
                    {t("私人题单", "Private Study List")}
                  </Label>
                  {list.starred && <Label>{t("已收藏", "Starred")}</Label>}
                  {list.archived && <Label>{t("已归档", "Archived")}</Label>}
                  <span className={style.privateNote}>{privateDescription}</span>
                </div>
                {list.description && (
                  <div className={style.description}>
                    <MarkdownContent content={list.description} />
                  </div>
                )}
                <Progress
                  className={style.completion}
                  value={completed}
                  total={details.length}
                  progress="ratio"
                  success={details.length > 0 && completed === details.length}
                  label={t("已通过", "Solved")}
                />
              </>
            )}
            <div className={problemSetStyle.tableContainer}>
              <Table basic="very" textAlign="center" unstackable>
                <Table.Header>
                  <Table.Row className={problemSetStyle.tableHeaderRow}>
                    <Table.HeaderCell width={1}>{t("状态", "Status")}</Table.HeaderCell>
                    <Table.HeaderCell width={1}>#</Table.HeaderCell>
                    <Table.HeaderCell textAlign="left">{t("题目名称", "Title")}</Table.HeaderCell>
                    <Table.HeaderCell width={1}>{t("难度", "Difficulty")}</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {list.items.map((item, i) => {
                    const detail = details.find(x => x.problemId === item.problemId);
                    return (
                      <React.Fragment key={item.problemId}>
                        <Table.Row className={problemSetStyle.row}>
                          <Table.Cell>
                            {detail?.accepted &&
                              (detail.submission?.id ? (
                                <Link
                                  href={`/s/${detail.submission.id}`}
                                  aria-label={t("已通过", "Accepted")}
                                  title={t("已通过", "Accepted")}
                                >
                                  <StatusIcon status="Accepted" noMarginRight />
                                </Link>
                              ) : (
                                <span role="img" aria-label={t("已通过", "Accepted")} title={t("已通过", "Accepted")}>
                                  <StatusIcon status="Accepted" noMarginRight />
                                </span>
                              ))}
                          </Table.Cell>
                          <Table.Cell>
                            <b>
                              {getProblemIdString(detail?.meta || item.problemId, { hideHashTagOnDisplayId: true })}
                            </b>
                          </Table.Cell>
                          <Table.Cell
                            textAlign="left"
                            className={`${problemSetStyle.problemTitleCell} ${style.titleCell}`}
                          >
                            {detail?.meta ? (
                              <EmojiRenderer>
                                <Link href={getProblemUrl(detail.meta)}>
                                  {getProblemDisplayName(null, detail.titles[appState.locale] || "", _)}
                                </Link>
                              </EmojiRenderer>
                            ) : (
                              <span className={style.unavailable}>{t("题目不可用", "Problem unavailable")}</span>
                            )}
                            {item.section && (
                              <div className={problemSetStyle.tags}>
                                <Label size="small">{item.section}</Label>
                              </div>
                            )}
                          </Table.Cell>
                          <Table.Cell>
                            <DifficultyRating value={detail?.meta?.difficulty} />
                          </Table.Cell>
                        </Table.Row>
                        {(editing || item.note) && (
                          <Table.Row className={style.noteRow}>
                            <Table.Cell colSpan={4} textAlign="left">
                              {editing ? (
                                <Form onSubmit={event => event.preventDefault()}>
                                  <Form.Input
                                    label={t("分组", "Section")}
                                    maxLength={120}
                                    value={item.section}
                                    onChange={(_, x) => changeItem(i, { section: x.value })}
                                  />
                                  <Form.TextArea
                                    label={t("笔记（Markdown / LaTeX）", "Notes (Markdown / LaTeX)")}
                                    rows={3}
                                    maxLength={10000}
                                    value={item.note}
                                    onChange={(_, x) => changeItem(i, { note: x.value })}
                                  />
                                  <Button
                                    type="button"
                                    size="tiny"
                                    icon="arrow up"
                                    title={t("上移", "Move up")}
                                    aria-label={t("上移", "Move up")}
                                    disabled={i === 0}
                                    onClick={() => {
                                      const items = [...list.items];
                                      [items[i - 1], items[i]] = [items[i], items[i - 1]];
                                      modify("items", items);
                                    }}
                                  />
                                  <Button
                                    type="button"
                                    size="tiny"
                                    icon="arrow down"
                                    title={t("下移", "Move down")}
                                    aria-label={t("下移", "Move down")}
                                    disabled={i === list.items.length - 1}
                                    onClick={() => {
                                      const items = [...list.items];
                                      [items[i + 1], items[i]] = [items[i], items[i + 1]];
                                      modify("items", items);
                                    }}
                                  />
                                  <Button
                                    type="button"
                                    size="tiny"
                                    icon="remove"
                                    title={t("移除", "Remove")}
                                    aria-label={t("移除", "Remove")}
                                    onClick={() =>
                                      modify(
                                        "items",
                                        list.items.filter((_, n) => n !== i)
                                      )
                                    }
                                  />
                                </Form>
                              ) : (
                                <div className={style.note}>
                                  <MarkdownContent content={item.note} />
                                </div>
                              )}
                            </Table.Cell>
                          </Table.Row>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {!busy && list.items.length === 0 && (
                    <Table.Row>
                      <Table.Cell colSpan={4} className={style.empty}>
                        {editing ? t("搜索并添加题目", "Search to add a problem") : t("暂无题目", "No problems")}
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table>
            </div>
            {editing && list.id && (
              <div className={style.editorActions}>
                <Button
                  basic
                  negative
                  onClick={() => setConfirmDelete(true)}
                  content={t("删除题单", "Delete study list")}
                />
              </div>
            )}
          </div>
        </>
      )}
      <Modal size="tiny" open={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <Modal.Header>{t("删除题单？", "Delete this study list?")}</Modal.Header>
        <Modal.Actions>
          <Button onClick={() => setConfirmDelete(false)}>{t("取消", "Cancel")}</Button>
          <Button
            negative
            onClick={async () => {
              try {
                await extensionApi("studyList/delete", { id: list.id });
                nav.navigate("/study-lists");
              } catch (e) {
                setError(e.message);
              }
              setConfirmDelete(false);
            }}
          >
            {t("删除", "Delete")}
          </Button>
        </Modal.Actions>
      </Modal>
    </>
  );
});
export default mount({
  "/": defineRoute(async () => <StudyLists key="list" />),
  "/new": defineRoute(async () => <StudyLists key="new" id="new" />),
  "/:id": defineRoute(async req => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1)
      throw new RouteError(appState.locale === "zh_CN" ? "题单不存在。" : "Study list not found.");
    return <StudyLists key={id} id={id} />;
  })
});
