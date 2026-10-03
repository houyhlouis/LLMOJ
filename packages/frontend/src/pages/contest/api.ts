import { createPostApi } from "@/api";
import { appState } from "@/appState";
import { RouteError } from "@/AppRouter";
import { CodeLanguage, normalizeContestLanguages } from "@/interfaces/CodeLanguage";

export const tr = (zh: string, en: string) => (appState.locale === "zh_CN" ? zh : en);
export const contestRequest = (action: string) => createPostApi<any, any>(`contest/${action}`, {});
export const submitContest = createPostApi<any, any>("contest/submit", { proofOfWorkAction: "submit_problem" });
export const prepareContestUpload = createPostApi<any, any>("contest/prepareUpload", {
  proofOfWorkAction: "prepare_submission_file_upload"
});
export async function callContest(action: string, request: any = {}) {
  const result = await contestRequest(action)(request);
  if (result.requestError || result.response?.error) {
    const code = result.requestErrorCode ?? result.response?.error;
    const message =
      code === "CONTEST_NOT_STARTED"
        ? tr("比赛尚未开始，题目将在开始后公开。", "Problems will become available when the contest starts.")
        : code === "LOGIN_REQUIRED" || result.requestErrorStatus === 401
        ? tr("请先登录。", "Please sign in.")
        : code === "PERMISSION_DENIED" || result.requestErrorStatus === 403
        ? tr(
            "没有访问此内容或执行此操作的权限。",
            "You do not have permission to access this content or perform this action."
          )
        : result.requestErrorStatus === 404
        ? tr("内容不存在或无权访问。", "Not found or unavailable.")
        : result.requestErrorStatus === 400
        ? tr("输入不合法，请检查内容后重试。", "Invalid input. Check the form and try again.")
        : tr("请求失败，请稍后重试。", "Request failed. Please try again later.");
    throw new RouteError(message, { showRefresh: true, showBack: true });
  }
  return result.response;
}
export const formatDate = (value: string) => new Date(value).toLocaleString(appState.locale.replace("_", "-"));
export const problemLetter = (index: number) => (index < 26 ? String.fromCharCode(65 + index) : String(index + 1));

export function languageChoices(languages: string[], localize: (key: string) => string) {
  return normalizeContestLanguages(languages).map(value => {
    const [language, version] = value.split(":");
    const text =
      language === "cpp"
        ? `${localize(`.cpp.options.std.values.${version}`)} (${localize(".cpp.options.compiler.values.g++")})`
        : language === "python"
        ? `${localize(".python.name")} ${localize(`.python.options.version.values.${version}`)}`
        : localize(`.${language}.name`);
    return { value, text };
  });
}

const chineseStatuses: Record<string, string> = {
  Pending: "等待评测",
  Waiting: "等待评测",
  Preparing: "准备评测",
  Compiling: "正在编译",
  Compiled: "编译成功",
  Running: "正在运行",
  Accepted: "通过",
  PartiallyCorrect: "部分正确",
  WrongAnswer: "答案错误",
  RuntimeError: "运行错误",
  TimeLimitExceeded: "超出时间限制",
  MemoryLimitExceeded: "超出内存限制",
  OutputLimitExceeded: "超出输出限制",
  CompilationError: "编译错误",
  FileError: "文件错误",
  JudgementFailed: "评测失败",
  ConfigurationError: "配置错误",
  SystemError: "系统错误",
  Canceled: "已取消",
  Skipped: "已跳过"
};

export const contestStatusText = (status?: string) =>
  status ? tr(chineseStatuses[status] ?? status, status.replace(/([A-Z])/g, " $1").trimStart()) : "—";

export const contestLanguageName = (language: string, localize: (key: string) => string) =>
  Object.values(CodeLanguage).includes(language as CodeLanguage) ? localize(`.${language}.name`) : language || "—";
