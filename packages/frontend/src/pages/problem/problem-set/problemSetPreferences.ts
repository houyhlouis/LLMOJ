import { observable, makeObservable, action } from "mobx";

// The problem set's own display settings, kept in this browser apart from the app-wide state (session, locale,
// theme). appState.ts moves the value saved there by earlier versions here.
export const PROBLEM_SET_PREFERENCES_KEY = "problemSetPreferences";

function readSaved(): { showTags?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(PROBLEM_SET_PREFERENCES_KEY)) || {};
  } catch {
    return {};
  }
}

class ProblemSetPreferences {
  constructor() {
    makeObservable(this);
  }

  // Show each problem's tags in the problem list, and open a problem with its tags shown
  @observable
  showTags = readSaved().showTags === true;

  @action
  setShowTags(showTags: boolean) {
    this.showTags = showTags;
    try {
      localStorage.setItem(PROBLEM_SET_PREFERENCES_KEY, JSON.stringify({ showTags }));
    } catch {
      // Not saved (storage full or blocked); it still applies until the page is reloaded
    }
  }
}

export const problemSetPreferences = new ProblemSetPreferences();
