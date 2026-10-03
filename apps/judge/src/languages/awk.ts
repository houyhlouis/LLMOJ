import { interpreted } from "./interpreted";

export const languageConfig = interpreted("awk", "/usr/bin/awk", "awk", ["-f"]);
