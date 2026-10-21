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
  judging: {
    title: "Judging",
    introduction:
      "How judge machines choose their next task. Submissions to contests that haven't ended always come first, then other new submissions, rejudges, hacks and self-evaluation, and AI runs. Changes apply within a few seconds.",
    fields: {
      contestReservedThreads: "Task threads each judge machine keeps for running contests",
      agingMinutes: "Minutes before a waiting task is moved ahead"
    },
    notes: {
      contestReservedThreads:
        "While a contest is running, each judge machine leaves this many of its task threads for contest submissions once its other tasks fill the rest, so a long rejudge or AI run can't delay a contest. A judge machine needs more task threads than this to keep any. 0 keeps none.",
      agingMinutes:
        "Once a task has waited this long, it gets every fifth free task thread, whatever its kind, so nothing waits forever behind newer work. Contest submissions still go first. 0 turns this off."
    },
    invalid: "Enter whole numbers within the allowed ranges.",
    saved: "Judging settings saved. Judge machines use them within a few seconds."
  },
  ai_endpoints: {
    title: "AI addresses",
    introduction:
      "Which provider, search and MCP addresses accounts may use in their AI configuration. A private or local address (such as a model server on your network) is reached from this server, not from the user's browser, so it needs your approval. Site administrators can use any address.",
    custom_label: "Addresses that aren't approved",
    custom: {
      public: "Allow public addresses; private and local ones need approval",
      approved: "Allow only approved addresses"
    },
    custom_notes:
      "With only approved addresses, users choose from the list below, and a configuration with another address isn't saved or used. Changes apply within a few seconds.",
    approved_title: "Approved addresses",
    none_approved: "No address is approved.",
    name: "Name shown to users",
    type: "API",
    base_url: "Base URL",
    remove: "Remove",
    remove_named: "Remove {name}",
    add: "Add address",
    approved_notes:
      "An approved Base URL covers every request at or below its path on the same scheme, host and port. Hosts listed in the server's HYHOJ_AI_PRIVATE_HOSTS are approved as well.",
    invalid: "Each approved address needs a name and an http or https Base URL without a password, query or fragment.",
    saved: "AI addresses saved. They apply within a few seconds.",
    usage_title: "Addresses in use",
    usage_introduction:
      "The addresses accounts saved in their AI configuration, and whether they can use them. Loading resolves each host once.",
    usage_load: "Show addresses in use",
    usage_reload: "Reload",
    usage_none: "No account has saved an AI configuration.",
    accounts: "Accounts",
    accounts_with_administrators: "{count} (administrators: {administrators})",
    status: "Status",
    statuses: {
      approved: "Approved",
      public: "Public address",
      private: "Private: administrators only",
      not_approved: "Not approved: administrators only"
    },
    unresolved: "The host name didn't resolve.",
    approve: "Approve",
    approval_unsaved: "Added above; save to approve."
  },
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
