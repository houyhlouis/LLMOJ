import { interpreted } from "./interpreted";

export const languageConfig = interpreted("perl", "/usr/bin/perl", "pl", [], ["-c"]);
