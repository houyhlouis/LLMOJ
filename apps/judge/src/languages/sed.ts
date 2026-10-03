import { interpreted } from "./interpreted";

export const languageConfig = interpreted("sed", "/usr/bin/sed", "sed", ["-f"]);
