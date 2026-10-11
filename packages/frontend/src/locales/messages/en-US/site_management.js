return {
  title: "Site management",
  introduction:
    "Manage registration for new users. Only site administrators can change these settings. Existing accounts and application decisions are unchanged.",
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
    "Could not confirm the save result: {error} Reload settings to check; your current selection has been kept."
};
