import getGitRepoInfo from "git-repo-info";

/** The checkout revision shown in session information, when the installed backend has one. */
export const appGitRepoInfo = getGitRepoInfo();
