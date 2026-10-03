import { interpreted } from "./interpreted";

export const languageConfig = interpreted("ruby", "/usr/bin/ruby", "rb", [], ["-c"]);
