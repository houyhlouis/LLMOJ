import { mount, lazy } from "navi";

import getRoute from "@/utils/getRoute";
import { solutionsRoute } from "./discussions/DiscussionsPage";

export default {
  solutions: solutionsRoute,
  d: mount({
    "/:id": mount({
      "/": lazy(() => import("./view/DiscussionViewPage")),
      "/edit": getRoute(() => import("./edit/DiscussionEditPage"), "edit")
    }),
    "/new": getRoute(() => import("./edit/DiscussionEditPage"), "new"),
    "/": lazy(() => import("./discussions/DiscussionsPage"))
  })
};
