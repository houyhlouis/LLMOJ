import { mount, lazy } from "navi";
import getRoute from "@/utils/getRoute";
export default {
  contests: lazy(() => import("./ContestsPage")),
  contest: mount({
    "/new": getRoute(() => import("./ContestEditPage"), "new"),
    "/:contestId": mount({
      "/": getRoute(() => import("./ContestPage"), "overview"),
      "/edit": getRoute(() => import("./ContestEditPage"), "edit"),
      "/ranklist": getRoute(() => import("./ContestPage"), "ranklist"),
      "/submissions": getRoute(() => import("./ContestPage"), "submissions"),
      "/summary": lazy(() => import("./ContestSummaryPage")),
      "/problem/:problemId": lazy(() => import("./ContestProblemPage")),
      "/submission/:submissionId": lazy(() => import("./ContestSubmissionPage"))
    })
  })
};
