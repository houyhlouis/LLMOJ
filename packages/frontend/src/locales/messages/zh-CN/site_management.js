return {
  title: "网站管理",
  introduction: "全站设置。仅站点管理员可以修改，修改后立即生效。",
  registration_title: "注册",
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
  save_unconfirmed: "未能确认保存结果：{error} 请重新加载设置核对，当前选择暂未清除。",
  ai: {
    title: "AI",
    introduction:
      "对 AI 服务商请求的限制。限制作用于请求所使用的 AI 配置所属的账号，无论请求来自任务还是 AI 配置页面。",
    paused: "暂停 AI",
    paused_notes:
      "暂停期间不会发出任何新的 AI 请求。正在进行的请求会完成；排队中和运行中的任务会等待，恢复后从中断处继续。",
    fields: {
      userDailyTokens: "每个账号 24 小时内的 token 数",
      userDailyRequests: "每个账号 24 小时内的模型和搜索请求数",
      jobRequests: "每个任务的模型和搜索请求数",
      concurrentRequests: "同时进行的 AI 请求数"
    },
    notes: {
      userDailyTokens:
        "服务商报告的输入和输出 token，按任意 24 小时计算。在服务商报告实际用量之前，每个请求按其最大可能用量（输出上限加上输入的估计值）计算；服务商未报告用量的请求一直按该最大值计算。0 表示不限制。",
      userDailyRequests:
        "模型生成和联网搜索（包括连通性测试）的次数，按任意 24 小时计算。模型列表和进度查询不计入。0 表示不限制。",
      jobRequests: "一个任务所有尝试（包括重试）的总数。0 表示不限制。",
      concurrentRequests: "全站（每个后端进程）的数量。任务会等待空位；没有空位时，模型列表和连接测试会被拒绝。"
    },
    invalid: "请输入允许范围内的整数。",
    saved: "AI 设置已保存并生效。"
  }
};
