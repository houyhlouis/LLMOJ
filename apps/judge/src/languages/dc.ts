import { interpreted } from "./interpreted";

export const languageConfig = interpreted("dc", "/usr/bin/dc", "dc", ["-f"]);
