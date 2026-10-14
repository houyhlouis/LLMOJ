// Capture the mode at boot so ordinary SPA links inside the mini browser keep it.
function detectEmbeddedDetailMode() {
  if (new URLSearchParams(window.location.search).get("embed") !== "1" || window.parent === window) return false;
  try {
    return window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

export const embeddedDetailMode = detectEmbeddedDetailMode();
export const detailPreviewCloseMessage = "llmoj:close-detail-preview";
export const detailPreviewFocusMessage = "llmoj:focus-detail-preview-controls";
