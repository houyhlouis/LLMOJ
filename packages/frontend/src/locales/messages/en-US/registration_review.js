return {
  title: "Registration reviews",
  introduction:
    "Review registration applications. Accounts and user IDs are created only after approval. Pending and rejected applicants are not site users. Administrators and users with Manage registration reviews can view all application emails and review notes, and approve rejected applications.",
  filter: "Application status",
  status: {
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
    all: "All"
  },
  refresh: "Refresh",
  loading: "Loading applications…",
  empty: "No applications match this filter.",
  account: "Requested username / Email",
  user_id: "User ID: {id}",
  registered: "Applied",
  state: "Status",
  review: "Review record",
  actions: "Actions",
  reviewer: "Reviewer #{id}",
  approve: "Approve",
  reject: "Reject",
  previous: "Previous",
  next: "Next",
  pagination: "Page {page} of {pages}, {count} applications",
  confirm_approve: "Approve registration for {username}",
  confirm_reject: "Reject registration for {username}",
  confirm_reapprove: "Approve the previously rejected application for {username}",
  reapprove_notice:
    "This application was previously rejected. Approval creates a site account that can sign in with the original registration password. Your reviewer ID, review time, and note will be recorded. Check that the reason for rejection has been resolved.",
  final_decision:
    "Your reviewer ID, review time, and note will be recorded. Rejected applications can be approved later; approved applications cannot be rejected here. Check the details before confirming.",
  note: "Review note (optional, up to 500 characters, authorized reviewers only)",
  cancel: "Cancel",
  confirm: "Confirm review",
  load_failed: "Unable to load applications. Click Refresh to retry.",
  save_failed: "Unable to confirm the review result. Refresh the list to check before retrying.",
  success: {
    approved: "Application approved and site account created. This user can now sign in.",
    rejected: "Application rejected. No site account was created."
  },
  errors: {
    DUPLICATE_USERNAME:
      "The requested username is already in use. Approval could not be completed; the application status is unchanged. Check the details before retrying.",
    DUPLICATE_EMAIL:
      "The requested email is already in use. Approval could not be completed; the application status is unchanged. Check the details before retrying.",
    PERMISSION_DENIED:
      "You do not have permission to manage registration reviews. Ask an administrator for access, then refresh the page.",
    NO_SUCH_APPLICATION: "This application no longer exists. Refresh the list.",
    ALREADY_REVIEWED:
      "This application has changed or the requested action is not allowed. Approved applications cannot be rejected. The list has been refreshed; close this window to view it."
  }
};
