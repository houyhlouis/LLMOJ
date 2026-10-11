return {
  title: "网站管理",
  introduction: "管理新用户的注册方式。仅站点管理员可以修改；不会改变已有账户或已有申请的审核结果。",
  permission_denied: "仅站点管理员可以管理网站设置。",
  registration_mode: "注册模式",
  modes: { open: "自由注册", approval: "管理员审核", closed: "关闭注册" },
  descriptions: {
    open: "用户完成注册后即可登录，原有邮箱验证等要求仍然有效。",
    approval: "用户提交申请后需等待审核，通过后才创建站点账户。管理员可以单独授予他人注册审核权限。",
    closed: "不接受新的注册申请。已有账户可以照常登录，已有申请仍可继续审核。"
  },
  effective_mode: "最近确认的生效模式：{mode}",
  configured_mode: "服务器配置的模式：{mode}",
  using_override: "当前使用网站管理中保存的模式。",
  using_configuration: "当前使用服务器配置，未设置网站管理覆盖。",
  unsaved: "选择尚未保存，不影响当前生效模式。",
  save: "保存",
  restore: "恢复服务器配置",
  restore_note: "恢复服务器配置会清除已保存的模式覆盖，并替换尚未保存的选择。修改后，其他已打开的页面请刷新后查看。",
  refresh: "重新加载设置",
  discard_changes: "重新加载会放弃尚未保存的选择，是否继续？",
  saved: "注册模式已保存并生效。",
  restored: "已恢复服务器配置，显示的模式已生效。",
  loading: "正在加载网站设置…",
  request_failed: "请求未完成，请重试。",
  invalid_response: "服务器返回了无法识别的设置，请重新加载后重试。",
  save_unconfirmed: "未能确认保存结果：{error} 请重新加载设置核对，当前选择暂未清除。"
};
