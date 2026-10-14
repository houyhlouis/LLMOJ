import { appState } from "@/appState";
import { extensionApi } from "@/utils/extensionApi";

export const tr = (zh: string, en: string) => (appState.locale === "zh_CN" ? zh : en);
export const hackApi = <T = any>(action: string, body?: unknown) => extensionApi<T>("hack/" + action, body);
export const hackStatuses = [
  "Pending",
  "Running",
  "Success",
  "Failed",
  "InvalidInput",
  "ConfigurationError",
  "SystemError",
  "Canceled"
] as const;
export type HackStatus = typeof hackStatuses[number];
export interface HackRecord {
  id: number;
  status: HackStatus;
  submissionId: number;
  problemId: number;
  contestId?: number;
  contestProblemId?: number;
  problemTitle?: string;
  submitter: { id: number; username: string };
  hacker: { id: number; username: string };
  timeUsed?: number;
  memoryUsed?: number;
  createTime: string;
  inputData?: string;
  message?: string;
  canManage?: boolean;
  testcaseResult?: {
    executed: boolean;
    status?: string;
    score?: number;
    timeUsed?: number;
    memoryUsed?: number;
  };
  testcaseInfo?: {
    timeLimit?: number;
    memoryLimit?: number;
  };
}
export const statusText = (status: HackStatus) =>
  ({
    Pending: tr("等待评测", "Pending"),
    Running: tr("正在评测", "Running"),
    Success: tr("Hack 成功", "Successful"),
    Failed: tr("Hack 失败", "Unsuccessful"),
    InvalidInput: tr("输入数据不合法", "Invalid input"),
    ConfigurationError: tr("评测配置不完整", "Configuration error"),
    SystemError: tr("系统错误", "System error"),
    Canceled: tr("已取消", "Canceled")
  }[status] || status);
export const submissionUrl = (record: Pick<HackRecord, "contestId" | "submissionId">) =>
  record.contestId ? `/contest/${record.contestId}/submission/${record.submissionId}` : `/s/${record.submissionId}`;
export const problemUrl = (record: Pick<HackRecord, "contestId" | "contestProblemId" | "problemId">) =>
  record.contestId ? `/contest/${record.contestId}/problem/${record.contestProblemId}` : `/p/id/${record.problemId}`;
export const dateText = (value: string) => new Date(value).toLocaleString(appState.locale.replace("_", "-"));
export const errorText = (error: any) =>
  typeof error?.message === "string"
    ? reasonText(error.message)
    : tr("请求失败，请重试。", "Request failed. Please try again.");
export function reasonText(reason: string) {
  if (appState.locale !== "zh_CN") return reason;
  return (
    {
      "Hack permission is required": "没有发起 Hack 的权限。",
      "Submission viewing permission is required": "没有查看提交记录的权限。",
      "Contest participation is not permitted": "没有参加此比赛的权限。",
      "Hacks are disabled for this contest": "此比赛未开启 Hack。",
      "Hacks open after the contest ends": "此赛制在比赛结束后才允许 Hack。",
      "The hack window is closed": "当前不在 Hack 开放时段。",
      "The contest hack window is closed": "当前不在比赛的 Hack 开放时段。",
      "Only traditional code submissions support hacks": "仅传统代码题支持 Hack。",
      "Wait until the target has finished judging": "请等待目标提交评测完成。",
      "The target has already been invalidated or canceled": "目标提交已经失效或取消。",
      "A problem manager must configure a trusted reference and input validator first":
        "题目管理员需要先配置 STD 和输入校验器。",
      "The configured reference is no longer an accepted submission": "当前 STD 已失效，请管理员更新配置。",
      "The trusted reference cannot be hacked": "作为 STD 来源的提交不能作为 Hack 目标。",
      "STD file I/O requires two distinct safe filenames":
        "请为 STD 填写两个不同的安全文件名，最多 255 字节，不允许路径、特殊符号或 hack-stderr。",
      "Self evaluation is disabled for this contest": "此比赛未开启自测。",
      "Self evaluation is outside the contest period": "自测仅在比赛时段内开放。",
      "Self evaluation is available only in enabled NOI contests": "Self Eval 仅在已开启此功能的 NOI / OI 比赛中提供。",
      "Configure self evaluation before the contest starts": "请在比赛开始前配置 Self Eval。",
      "A manager must configure formal make.cpp and std.cpp before the contest":
        "请管理员在赛前配置正式数据使用的 make.cpp 和 std.cpp。",
      "Provide make.cpp and std.cpp source code (maximum 1 MiB each)":
        "请填写 make.cpp 和 std.cpp 源代码，每份最多 1 MiB。",
      "Could not save the self-evaluation source file": "Self Eval 源程序保存失败，请重试。",
      "Prepare the fixed prediction set before the contest starts": "请在比赛开始前准备预测试数据。",
      "Self evaluation attempt limit reached": "Self Eval 次数已用完。",
      "The fixed prediction set is being prepared; retry when it is ready": "预测试数据正在准备，请就绪后重试。",
      "A manager must bind the same generator, standard and validator used for formal data":
        "题目管理员需要先绑定生成正式数据的生成器、标准程序和校验器。",
      "The prepared set no longer matches this problem configuration; a manager must prepare it again before the contest":
        "当前预测试集已与题目配置不一致，请管理员在比赛开始前重新准备。"
    }[reason] || reason
  );
}
