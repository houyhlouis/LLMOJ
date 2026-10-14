import { mount, lazy } from "navi";
export default mount({
  "/": lazy(() => import("./HacksPage")),
  "/:hackId": lazy(() => import("./HackPage"))
});
