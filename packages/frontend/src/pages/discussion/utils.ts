import { appState } from "@/appState";

export function getDiscussionDisplayTitle(title: string, _: (id: string) => string) {
  if (title === "题解 / Tutorial") return appState.locale === "zh_CN" ? "题解" : "Tutorial";
  return title.trim() || _("discussions.no_title");
}

export function getDiscussionUrl(meta: ApiTypes.DiscussionMetaDto) {
  return `/d/${meta.id}`;
}
