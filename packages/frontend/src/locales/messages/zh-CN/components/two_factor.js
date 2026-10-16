return {
  prompt: {
    totp: "请输入身份验证器应用中的 6 位验证码。",
    totp_placeholder: "6 位验证码",
    passkey: "请使用通行密钥确认身份。",
    passkey_button: "使用通行密钥",
    passkey_unsupported: "此浏览器无法在本站使用通行密钥，请选择其他验证方式。",
    recovery_code: "请输入一个恢复码。每个恢复码只能使用一次。",
    recovery_code_placeholder: "xxxx-xxxx-xxxx-xxxx",
    verify: "验证",
    use_totp: "使用身份验证器验证码",
    use_passkey: "使用通行密钥",
    use_recovery_code: "使用恢复码",
    passkey_cancelled: "通行密钥请求已取消或超时。",
    passkey_failed: "浏览器无法使用通行密钥：{message}"
  },
  errors: {
    INVALID_CODE: "验证码不正确，请重试。",
    INVALID_PASSKEY: "无法验证此通行密钥，请重试或选择其他方式。",
    CHALLENGE_EXPIRED: "本次验证已过期，请重新开始。",
    TOO_MANY_ATTEMPTS: "尝试次数过多，请 15 分钟后再试。",
    WRONG_PASSWORD: "密码错误。",
    EMPTY_PASSWORD: "请输入密码。",
    PERMISSION_DENIED: "没有权限。",
    NO_SUCH_USER: "用户不存在。",
    REGISTRATION_PENDING: "你的注册申请正在等待审核。",
    REGISTRATION_REJECTED: "你的注册申请已被拒绝。",
    ALREADY_LOGGEDIN: "你已经登录。"
  },
  reauthenticate: {
    header: "确认身份",
    message: "请输入密码以继续。",
    message_two_factor: "请输入密码，然后完成两步验证。",
    password: "密码",
    confirm: "确认",
    cancel: "取消"
  }
};
