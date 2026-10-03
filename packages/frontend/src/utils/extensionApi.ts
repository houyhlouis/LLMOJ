import { appState } from "@/appState";
import { RouteError } from "@/AppRouter";
export async function extensionApi<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${window.apiEndpoint}api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(appState.token ? { Authorization: `Bearer ${appState.token}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  let data: any;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok || data.error) {
    const zh = appState.locale === "zh_CN";
    const messages = {
      400: zh ? "输入不合法，请检查内容。" : "Invalid input. Check the form.",
      401: zh ? "请先登录。" : "Please sign in.",
      403: zh ? "没有执行此操作的权限。" : "Permission denied.",
      404: zh ? "内容不存在或无权访问。" : "Not found or unavailable.",
      409: zh ? "内容已更新，请刷新后重试。" : "Content changed. Reload and try again."
    };
    throw new RouteError(
      messages[response.status] || (zh ? "请求失败，请重试。" : "Request failed. Please try again.")
    );
  }
  return data;
}
