// Messages for screen readers: two visually hidden live regions that exist from the start (a region added together
// with its text is often not read). "polite" waits for the reader to finish; "assertive" interrupts, for errors.
const regions: Partial<Record<"polite" | "assertive", HTMLElement>> = {};

function region(politeness: "polite" | "assertive") {
  if (!regions[politeness]) {
    const element = document.createElement("div");
    element.className = "visually-hidden";
    element.setAttribute("aria-live", politeness);
    element.setAttribute("aria-atomic", "true");
    if (politeness === "assertive") element.setAttribute("role", "alert");
    document.body.appendChild(element);
    regions[politeness] = element;
  }
  return regions[politeness];
}

export function initAnnouncer() {
  region("polite");
  region("assertive");
}

export function announce(message: string, politeness: "polite" | "assertive" = "polite") {
  if (!message) return;
  const element = region(politeness);
  // Clear first, so the same message said twice is read twice.
  element.textContent = "";
  setTimeout(() => (element.textContent = message), 50);
}
