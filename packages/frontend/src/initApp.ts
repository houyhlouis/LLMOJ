import { appState, initAppStateStore } from "@/appState";
import { loadGoogleAnalytics, loadPlausible } from "@/misc/analytics";
import { apiSameOrigin, isSessionMarker } from "@/utils/session";
import api from "@/api";

interface SessionSwrInfo {
  version: number;
  token: string;
  sessionInfo: ApiTypes.GetSessionInfoResponseDto;
  date: number;
}

const SESSION_SWR_INFO_KEY = "session-swr";
const SESSION_SWR_INFO_VERSION = 1;
const SESSION_SWR_INFO_VALID_FOR = 7 * 24 * 60 * 60 * 1000;

function applySessionInfo(sessionInfo: ApiTypes.GetSessionInfoResponseDto) {
  appState.currentUser = sessionInfo.userMeta;
  appState.currentUserJoinedGroupsCount = sessionInfo.joinedGroupsCount;
  appState.currentUserPrivileges = sessionInfo.userPrivileges || [];
  appState.userPreference = sessionInfo.userPreference || {};
  appState.serverPreference = sessionInfo.serverPreference;
  appState.serverVersion = sessionInfo.serverVersion;
}

function saveSessionSwrInfo(sessionInfo: ApiTypes.GetSessionInfoResponseDto) {
  localStorage.setItem(
    SESSION_SWR_INFO_KEY,
    JSON.stringify(<SessionSwrInfo>{
      version: SESSION_SWR_INFO_VERSION,
      // Only a cookie session's marker is kept here: a session token stays out of this cache
      token: isSessionMarker(appState.token) ? appState.token : "",
      sessionInfo,
      date: Date.now()
    })
  );
}

// Wait for getSessionInfo JSONP API returns
async function waitForSessionInitialization() {
  const sessionInfo =
    window.sessionInfo ||
    (await new Promise(resolve => {
      window.getSessionInfoCallback = sessionInfo => {
        resolve(sessionInfo);
        delete window.getSessionInfoCallback;
      };
    }));

  delete window.sessionInfo;
  applySessionInfo(sessionInfo);
  // On the API's origin the session cookie is what counts: keep its marker, or forget a marker whose session is gone
  if (sessionInfo.sessionMarker) appState.token = sessionInfo.sessionMarker;
  else if (isSessionMarker(appState.token) && !sessionInfo.userMeta) appState.token = "";
  saveSessionSwrInfo(sessionInfo);
  console.log("session refreshed");
}

// SWR cache for getSessionInfo JSONP API
function firstSessionInitialization() {
  let sessionSwrInfo: SessionSwrInfo;
  try {
    sessionSwrInfo = JSON.parse(localStorage.getItem(SESSION_SWR_INFO_KEY));
  } catch {}

  let usingCachedSessionInfo = false;
  if (
    sessionSwrInfo?.version === SESSION_SWR_INFO_VERSION &&
    Date.now() - sessionSwrInfo.date <= SESSION_SWR_INFO_VALID_FOR
  ) {
    console.log("session stale");
    applySessionInfo(sessionSwrInfo.sessionInfo);
    usingCachedSessionInfo = true;
  }

  // revalidate (and apply new session info after)
  const waitNewSessionInfoPromise = waitForSessionInitialization();
  if (!usingCachedSessionInfo) return waitNewSessionInfoPromise;
}

/**
 * A page that signed in before sessions were kept in cookies still holds its session token: move the session into the
 * HttpOnly cookie, so that the token leaves page storage. Nothing changes where the server keeps sessions in headers.
 */
async function moveSessionToCookie() {
  const { token } = appState;
  if (!token || isSessionMarker(token) || !apiSameOrigin()) return;
  const { response } = await api.auth.moveSessionToCookie();
  // Unless a sign-in or sign-out replaced the token meanwhile
  if (isSessionMarker(response?.token) && appState.token === token) appState.token = response.token;
}

export default async function initApp() {
  await initAppStateStore();
  await firstSessionInitialization();
  moveSessionToCookie().catch(error => console.error(error));
  loadGoogleAnalytics(appState.serverPreference.misc.googleAnalyticsId);
  loadPlausible(appState.serverPreference.misc.plausibleApiEndpoint);
}

export const refreshSession = async () => {
  window.refreshSession(appState.token);
  await waitForSessionInitialization();
};
