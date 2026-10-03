import { interpreted } from "./interpreted";

export const languageConfig = interpreted("bc", "/usr/bin/bc", "bc", ["-q"]);
