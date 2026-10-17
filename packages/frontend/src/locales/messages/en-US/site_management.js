return {
  title: "Site management",
  introduction: "Settings for the whole site. Only site administrators can change them, and changes apply at once.",
  registration_title: "Registration",
  permission_denied: "Only site administrators can manage site settings.",
  registration_mode: "Registration mode",
  modes: { open: "Open registration", approval: "Administrator approval", closed: "Registration closed" },
  descriptions: {
    open: "Users can sign in after registering. Existing requirements such as email verification still apply.",
    approval:
      "Users submit an application and wait for approval before a site account is created. Administrators can separately delegate registration review access.",
    closed:
      "New applications are not accepted. Existing accounts can sign in and existing applications can still be reviewed."
  },
  effective_mode: "Last confirmed effective mode: {mode}",
  configured_mode: "Server-configured mode: {mode}",
  using_override: "Using the mode saved in site management.",
  using_configuration: "Using server configuration, with no site management override.",
  unsaved: "This selection is not saved and does not change the effective mode.",
  save: "Save",
  restore: "Restore server configuration",
  restore_note:
    "Restoring server configuration removes the saved override and replaces any unsaved selection. Refresh other open pages to see a change.",
  refresh: "Reload settings",
  discard_changes: "Reloading will discard your unsaved selection. Continue?",
  saved: "Registration mode saved and now effective.",
  restored: "Server configuration restored. The displayed mode is now effective.",
  loading: "Loading site settings…",
  request_failed: "The request did not complete. Please try again.",
  invalid_response: "The server returned unrecognized settings. Reload and try again.",
  save_unconfirmed:
    "Could not confirm the save result: {error} Reload settings to check; your current selection has been kept.",
  ai: {
    title: "AI",
    introduction:
      "Limits on requests to AI providers. They apply to the account whose AI configuration a request uses, whether it comes from a job or from the AI configuration page.",
    paused: "Pause AI",
    paused_notes:
      "While AI is paused, no AI request starts. Requests already running finish; queued and running jobs wait and continue where they stopped when AI is resumed.",
    fields: {
      userDailyTokens: "Tokens per account in 24 hours",
      userDailyRequests: "Model and search requests per account in 24 hours",
      jobRequests: "Model and search requests per job",
      concurrentRequests: "AI requests at the same time"
    },
    notes: {
      userDailyTokens:
        "Input and output tokens the provider reports, over any 24 hours. Each request counts the most it could use (its output limit plus an estimate of its input) until the provider reports what it used; requests whose usage isn't reported keep counting at that maximum. 0 for no limit.",
      userDailyRequests:
        "Model generations and web searches (including connection tests), over any 24 hours. Model lists and progress checks don't count. 0 for no limit.",
      jobRequests: "Across all attempts of one job, including retries. 0 for no limit.",
      concurrentRequests:
        "For the whole site (each backend process). Jobs wait for a free place; model lists and connection tests are refused when none is free."
    },
    invalid: "Enter whole numbers within the allowed ranges.",
    saved: "AI settings saved and now effective."
  }
};
