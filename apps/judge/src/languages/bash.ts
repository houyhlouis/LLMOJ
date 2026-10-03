import { interpreted } from "./interpreted";

export const languageConfig = interpreted("bash", "/bin/bash", "sh", [], ["-n"]);
