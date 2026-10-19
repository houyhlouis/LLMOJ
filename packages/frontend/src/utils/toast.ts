import Noty from "noty";

import { announce } from "./announce";

function noty(type: Noty.Type, text: string, timeout: number) {
  const noty = new Noty({
    type,
    text,
    layout: "topRight",
    theme: "semanticui"
  });

  noty.show();

  // Noty's own live region appears together with the first toast, so screen readers often miss that one. The page's
  // announcer reads every toast instead, errors at once.
  const layout = (noty as unknown as { layoutDom?: HTMLElement }).layoutDom;
  if (layout) {
    layout.removeAttribute("role");
    layout.setAttribute("aria-live", "off");
  }
  announce(text.replace(/<[^>]*>/g, ""), type === "error" ? "assertive" : "polite");

  setTimeout(() => noty.close(), timeout);
}

export default {
  success(message: string, timeout: number = 5000) {
    noty("success", message, timeout);
  },
  info(message: string, timeout: number = 5000) {
    noty("alert", message, timeout);
  },
  warning(message: string, timeout: number = 5000) {
    noty("warning", message, timeout);
  },
  error(message: string, timeout: number = 5000) {
    noty("error", message, timeout);
  }
};
