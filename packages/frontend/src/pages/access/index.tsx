import React, { useEffect, useState } from "react";
import { Header, Icon, Loader, Message, Table, Dropdown, Button, Input, Label } from "semantic-ui-react";
import { observer } from "mobx-react";
import { defineRoute } from "@/AppRouter";
import { appState } from "@/appState";
import UserSearch from "@/components/UserSearch";
import { extensionApi } from "@/utils/extensionApi";
import style from "./AccessPage.module.less";
const AccessPage = observer(() => {
  const zh = appState.locale === "zh_CN",
    t = (a: string, b: string) => (zh ? a : b);
  const [catalog, setCatalog] = useState<any[]>([]),
    [user, setUser] = useState<any>(),
    [overrides, setOverrides] = useState<Record<string, boolean | null>>({});
  const [effective, setEffective] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    appState.enterNewPage(t("权限管理", "Permissions"));
    if (appState.currentUser?.isAdmin)
      extensionApi("access/catalog")
        .then(x => setCatalog(x.catalog))
        .catch(e => setError(e.message));
  }, [appState.locale]);
  async function select(id: number) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const x = await extensionApi("access/get", { userId: id });
      setUser(x.user);
      setOverrides(x.overrides);
      setEffective(x.effective);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const groups = {
    general: t("站点", "Site"),
    users: t("用户与用户组", "Users and groups"),
    problem: t("题目", "Problems"),
    submission: t("提交与评测", "Submissions"),
    discussion: t("讨论与题解", "Discussions"),
    contest: t("比赛", "Contests"),
    personal: t("题单与总结", "Study lists and summaries"),
    ai: "AI",
    management: t("管理特权", "Administration")
  };
  return (
    <>
      <Header as="h1" className="withIcon">
        <Icon name="shield alternate" />
        {t("权限管理", "Permissions")}
      </Header>
      {!appState.currentUser?.isAdmin ? (
        <Message negative content={t("仅管理员可访问。", "Administrator access required.")} />
      ) : (
        <>
          <p className={style.notes}>
            {t(
              "逐用户设置默认、允许或拒绝。所有规则由后端验证；私人题单、私人总结和API密钥仍仅归本人访问。管理员账号始终保有管理权限。",
              "Set defaults, grants, or denials for each user. Rules are enforced by the server. Private study lists, summaries, and API keys remain owner-only. Administrators retain administration access."
            )}
          </p>
          <p className={style.notes}>
            {t(
              "“管理注册审核”允许查看所有注册申请的邮箱和审核备注、通过或拒绝待审申请，以及重新批准已拒绝的申请。此权限默认关闭，且仍须具有“访问站点”权限。它不授予权限管理能力；只有管理员可以分配。",
              "Manage registration reviews grants access to all application emails and review notes, approval or rejection of pending applications, and approval after rejection. It is disabled by default, still requires Access the site, and does not grant permission management; only administrators can assign it."
            )}
          </p>
          <UserSearch onResultSelect={x => select(x.id)} />
          {error && <Message negative content={error} />}
          {saved && <Message positive content={t("权限已保存。", "Permissions saved.")} />}
          {user && (
            <div className={style.content} aria-busy={busy}>
              {busy && <Loader active inline="centered" />}
              <Header as="h2">
                {user.username} {user.isAdmin && <Label>{t("管理员", "Administrator")}</Label>}
              </Header>
              <Input
                className={style.search}
                icon="search"
                value={query}
                placeholder={t("搜索权限", "Search permissions")}
                onChange={(_, x) => setQuery(x.value)}
              />
              {Object.keys(groups).map(group => (
                <React.Fragment key={group}>
                  <Header as="h3" className={style.sectionHeader}>
                    {groups[group]}
                  </Header>
                  <Table basic="very" unstackable className={style.permissionTable}>
                    <Table.Body>
                      {catalog
                        .filter(
                          x =>
                            x.category === group &&
                            `${x.key} ${x.zh} ${x.en}`.toLowerCase().includes(query.toLowerCase())
                        )
                        .map(x => (
                          <Table.Row key={x.key}>
                            <Table.Cell>
                              <strong>{zh ? x.zh : x.en}</strong>
                              <div style={{ opacity: 0.6 }}>{x.key}</div>
                            </Table.Cell>
                            <Table.Cell collapsing>
                              <Label color={effective.includes(x.key) ? "green" : undefined}>
                                {effective.includes(x.key) ? t("当前允许", "Allowed") : t("当前拒绝", "Denied")}
                              </Label>
                            </Table.Cell>
                            <Table.Cell collapsing>
                              <Dropdown
                                selection
                                value={overrides[x.key] == null ? "default" : overrides[x.key] ? "allow" : "deny"}
                                options={[
                                  { key: "default", value: "default", text: t("默认", "Default") },
                                  { key: "allow", value: "allow", text: t("允许", "Allow") },
                                  { key: "deny", value: "deny", text: t("拒绝", "Deny") }
                                ]}
                                onChange={(_, d) => {
                                  setOverrides({
                                    ...overrides,
                                    [x.key]: d.value === "default" ? null : d.value === "allow"
                                  });
                                  setSaved(false);
                                }}
                              />
                            </Table.Cell>
                          </Table.Row>
                        ))}
                    </Table.Body>
                  </Table>
                </React.Fragment>
              ))}
              <Button
                primary
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const x = await extensionApi("access/set", { userId: user.id, overrides });
                    setOverrides(x.overrides);
                    setEffective(x.effective);
                    setSaved(true);
                  } catch (e) {
                    setError(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("保存权限", "Save permissions")}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
});
export default defineRoute(async () => <AccessPage />);
