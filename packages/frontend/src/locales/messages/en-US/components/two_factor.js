return {
  prompt: {
    totp: "Enter the 6-digit code from your authenticator app.",
    totp_placeholder: "6-digit code",
    passkey: "Use your passkey to confirm it's you.",
    passkey_button: "Use passkey",
    passkey_unsupported: "This browser can't use passkeys on this site. Choose another way to sign in.",
    recovery_code: "Enter one of your recovery codes. Each code works only once.",
    recovery_code_placeholder: "xxxx-xxxx-xxxx-xxxx",
    verify: "Verify",
    use_totp: "Use an authenticator code",
    use_passkey: "Use a passkey",
    use_recovery_code: "Use a recovery code",
    passkey_cancelled: "The passkey request was cancelled or timed out.",
    passkey_failed: "Your browser couldn't use the passkey: {message}"
  },
  errors: {
    INVALID_CODE: "Incorrect code. Try again.",
    INVALID_PASSKEY: "This passkey couldn't be verified. Try again or choose another way.",
    CHALLENGE_EXPIRED: "This confirmation expired. Start again.",
    TOO_MANY_ATTEMPTS: "Too many attempts. Wait 15 minutes and try again.",
    WRONG_PASSWORD: "Wrong password.",
    EMPTY_PASSWORD: "Enter your password.",
    PERMISSION_DENIED: "Permission denied.",
    NO_SUCH_USER: "No such user.",
    REGISTRATION_PENDING: "Your registration application is awaiting review.",
    REGISTRATION_REJECTED: "Your registration application was rejected.",
    ALREADY_LOGGEDIN: "You have already logged in."
  },
  reauthenticate: {
    header: "Confirm it's you",
    message: "Enter your password to continue.",
    message_two_factor: "Enter your password, then confirm with your second sign-in step.",
    password: "Password",
    confirm: "Confirm",
    cancel: "Cancel"
  }
};
