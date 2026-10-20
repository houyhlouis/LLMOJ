import React, { useEffect, useState } from "react";
import { Breadcrumb, Form, Label, Segment } from "semantic-ui-react";
import { v4 as uuid } from "uuid";
import { observer } from "mobx-react";

import style from "./DiscussionEditPage.module.less";

import { defineRoute, RouteError } from "@/AppRouter";
import api from "@/api";
import { appState } from "@/appState";
import { useLocalizer, useNavigationChecked } from "@/utils/hooks";
import { DiscussionEditor } from "../view/DiscussionViewPage";
import { getBreadcrumb } from "../discussions/DiscussionsPage";
import toast from "@/utils/toast";
import { makeToBeLocalizedText } from "@/locales";
import ProblemSearch from "@/components/ProblemSearch";
import { getProblemDisplayName, getProblemUrl } from "@/pages/problem/utils";

interface DiscussionEditPageProps {
  initialType?: "Discussion" | "Solution";
  problem?: {
    meta: ApiTypes.ProblemMetaDto;
    title: string;
  };
  discussion?: ApiTypes.DiscussionDto;
}

let DiscussionEditPage: React.FC<DiscussionEditPageProps> = props => {
  const _ = useLocalizer("discussion_edit");
  const navigation = useNavigationChecked();

  const [title, setTitle] = useState(props.discussion ? props.discussion.meta.title : "");
  const [content, setContent] = useState(props.discussion ? props.discussion.content : "");
  const [type, setType] = useState<"Discussion" | "Solution">(
    props.discussion?.meta.type || props.initialType || "Discussion"
  );
  const [problem, setProblem] = useState(props.discussion?.problem || props.problem);
  const canClassify =
    !props.discussion ||
    props.discussion.publisher.id === appState.currentUser?.id ||
    appState.currentUserHasPrivilege("ManageDiscussion");
  useEffect(() => {
    const titleKey = type === "Solution" ? ".title_solution" : ".title";
    appState.enterNewPage(
      props.discussion ? `${_(titleKey + "_update")} #${props.discussion.meta.id}` : _(titleKey + "_new")
    );
  }, [appState.locale, props.discussion, type]);

  async function onSubmit() {
    if (type === "Solution" && !problem) {
      toast.error(_(".errors.SOLUTION_REQUIRES_PROBLEM"));
      return false;
    }
    const { requestError, response } = props.discussion
      ? await api.discussion.updateDiscussion({
          discussionId: props.discussion.meta.id,
          title,
          content,
          ...(canClassify ? { type, problemId: problem?.meta.id ?? null } : {})
        })
      : await api.discussion.createDiscussion({
          problemId: problem?.meta?.id,
          title,
          content,
          type
        });

    if (requestError) toast.error(requestError(_));
    else if (response.error) toast.error(_(`.errors.${response.error}`));
    else {
      const newId = props.discussion
        ? props.discussion.meta.id
        : (response as ApiTypes.CreateDiscussionResponseDto).discussionId;
      return () => navigation.navigate(`/d/${newId}`);
    }

    return false;
  }

  return (
    <>
      {getBreadcrumb(
        problem,
        _,
        null,
        <>
          <Breadcrumb.Divider icon="right angle" />
          <Breadcrumb.Section>
            {props.discussion
              ? `${_(type === "Solution" ? ".header.update_solution" : ".header.update")} #${props.discussion.meta.id}`
              : _(type === "Solution" ? ".header.add_solution" : ".header.add")}
          </Breadcrumb.Section>
        </>,
        type
      )}
      {canClassify && (
        <Segment>
          <Form>
            <Form.Dropdown
              label={_(".category")}
              selection
              value={type}
              options={[
                { key: "Discussion", value: "Discussion", text: _(".discussion") },
                { key: "Solution", value: "Solution", text: _(".solution") }
              ]}
              onChange={(_event, data) => setType(data.value as "Discussion" | "Solution")}
            />
            <Form.Field required={type === "Solution"}>
              <label>{_(".problem")}</label>
              {problem && (
                <Label
                  content={getProblemDisplayName(problem.meta, problem.title, _, "all")}
                  onRemove={() => setProblem(null)}
                />
              )}
              <ProblemSearch onResultSelect={selected => setProblem({ meta: selected.meta, title: selected.title })} />
            </Form.Field>
          </Form>
        </Segment>
      )}
      <DiscussionEditor
        className={style.editor}
        type={props.discussion ? "UpdateDiscussion" : "NewDiscussion"}
        publisher={props.discussion?.publisher || appState.currentUser}
        title={title}
        content={content}
        onChangeTitle={title => title.length <= 80 && setTitle(title)}
        onChangeContent={setContent}
        onCancel={() =>
          navigation.navigate(
            props.discussion
              ? `/d/${props.discussion.meta.id}`
              : type === "Solution" && problem
                ? { pathname: getProblemUrl(problem.meta), query: { tab: "solutions" } }
                : "/d"
          )
        }
        onSubmit={onSubmit}
        noSubmitPermission={props.discussion && !props.discussion.permissions.includes("Modify")}
      />
    </>
  );
};

DiscussionEditPage = observer(DiscussionEditPage);

export default {
  new: defineRoute(async request => {
    if (!(
      (appState.currentUser && appState.serverPreference.security.allowEveryoneCreateDiscussion) ||
      appState.currentUserHasPrivilege("ManageDiscussion")
    )) {
      throw new RouteError(makeToBeLocalizedText(`discussion_edit.errors.PERMISSION_DENIED`));
    }

    const problem = await (async (): Promise<DiscussionEditPageProps["problem"]> => {
      const problemId = request.query.problemId ?? request.params.problemId;
      if (problemId == null) return null;

      const { requestError, response } = await api.problem.getProblem({
        id: Number(problemId) || 0,
        localizedContentsOfLocale: appState.locale,
        localizedContentsTitleOnly: true
      });

      if (requestError) throw new RouteError(requestError, { showRefresh: true, showBack: true });
      else if (response.error) throw new RouteError(makeToBeLocalizedText(`discussion_edit.errors.${response.error}`));

      return {
        meta: response.meta,
        title: response.localizedContentsOfLocale.title
      };
    })();

    return (
      <DiscussionEditPage
        key={uuid()}
        problem={problem}
        initialType={request.query.type === "Solution" ? "Solution" : "Discussion"}
      />
    );
  }),
  edit: defineRoute(async request => {
    const { requestError, response } = await api.discussion.getDiscussionAndReplies({
      locale: appState.locale,
      discussionId: Number(request.params.id) || 0,
      getDiscussion: true
    });

    if (requestError) throw new RouteError(requestError, { showRefresh: true, showBack: true });
    else if (response.error) throw new RouteError(makeToBeLocalizedText(`discussion_edit.errors.${response.error}`));

    return <DiscussionEditPage key={uuid()} discussion={response.discussion} />;
  })
};
