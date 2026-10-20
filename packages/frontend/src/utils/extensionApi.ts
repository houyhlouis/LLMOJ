import { appState } from "@/appState";
import { RouteError } from "@/AppRouter";
import { confirmIdentity, needsReauthentication } from "@/utils/reauthentication";
import { noteSessionEnded, responseRequestId, sessionHeaders } from "@/utils/session";

export async function extensionApi<T = any>(path: string, body?: unknown, confirmed = false): Promise<T> {
  const { token } = appState;
  const response = await fetch(`${window.apiEndpoint}api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...sessionHeaders(token)
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (response.headers.get("X-Session-Ended")) noteSessionEnded(token);
  let data: any;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  // A sensitive change refused for want of a recent password entry changed nothing: confirm and send it again.
  if (!confirmed && needsReauthentication(data) && (await confirmIdentity()))
    return await extensionApi<T>(path, body, true);
  if (!response.ok || data.error) {
    const zh = appState.locale === "zh_CN";
    const requestId = responseRequestId({ "x-request-id": response.headers.get("X-Request-Id") }, data);
    const messages = {
      400: zh ? "输入不合法，请检查内容。" : "Invalid input. Check the form.",
      401: zh ? "请先登录。" : "Please sign in.",
      403: needsReauthentication(data)
        ? zh
          ? "请先确认密码再进行此更改。"
          : "Confirm your password to make this change."
        : zh
          ? "没有执行此操作的权限。"
          : "Permission denied.",
      404: zh ? "内容不存在或无权访问。" : "Not found or unavailable.",
      409: zh ? "内容已更新，请刷新后重试。" : "Content changed. Reload and try again."
    };
    const message =
      response.status >= 500 && requestId
        ? zh
          ? `服务器错误，请稍后重试。如果一直出现，请把错误编号告诉管理员：${requestId}`
          : `Server error. Please try again later. If it keeps happening, give the administrator this error ID: ${requestId}`
        : messages[response.status] || (zh ? "请求失败，请重试。" : "Request failed. Please try again.");
    throw new RouteError(message);
  }
  return data;
}
