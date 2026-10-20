import { appState } from "@/appState";
import { extensionApi } from "@/utils/extensionApi";

export const tr = (zh: string, en: string) => (appState.locale === "zh_CN" ? zh : en);
export const teamApi = (action: string, body?: unknown) => extensionApi("team/" + action, body);
export const parseIds = (value: string) => {
  const ids = value.trim()
    ? value
        .trim()
        .split(/[\s,，]+/)
        .map(Number)
    : [];
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0))
    throw new Error(
      tr("请输入有效的用户编号，以逗号或空格分隔。", "Enter valid user IDs separated by commas or spaces.")
    );
  return Array.from(new Set(ids));
};
export const dateText = (value: string) =>
  value ? new Date(value).toLocaleString(appState.locale.replace("_", "-")) : tr("无截止时间", "No deadline");
export const localDateInput = (value: string) => {
  if (!value) return "";
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export const joinPolicyText = (policy: string) =>
  ({
    open: tr("免审核加入", "Join without approval"),
    approval: tr("申请审核", "Approval required"),
    closed: tr("仅邀请", "Invitation only")
  })[policy] || policy;
export const policyOptions = () =>
  ["open", "approval", "closed"].map(value => ({ value, text: joinPolicyText(value) }));
export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(
    new Blob([csv.startsWith("\ufeff") ? csv : "\ufeff" + csv], { type: "text/csv;charset=utf-8" })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
