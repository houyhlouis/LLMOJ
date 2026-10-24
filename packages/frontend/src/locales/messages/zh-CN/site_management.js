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
  test_data: {
    title: "已移除的测试数据",
    introduction:
      "题目的测试数据被替换或移除后，只要还有需要，它的文件就会保留，以便用同样的数据重新评测用它评测过的结果。等待中的提交、Hack 和自测，以及题目管理者在提交页面上选择保留的数据版本，总会保留这些文件。在这里设置比赛和评测结果再保留多久。缺少文件的数据版本显示为已删除：它的评测结果仍可查看，但无法复现。",
    fields: {
      contestDays: "比赛结束后保留的天数",
      resultDays: "为评测结果保留的天数"
    },
    notes: {
      contestDays:
        "比赛提交所用的测试数据在比赛进行期间以及结束后的这些天内保留，以便申诉和更正。0 表示只在比赛进行期间保留。",
      resultDays: "评测结果所用的测试数据在移除后、以及重测替换这类结果后保留这些天。0 表示没有任务等待时即删除。"
    },
    invalid: "请输入允许范围内的整数。",
    saved: "已保存。下次清理时生效。",
    refresh: "重新查看",
    dry_run: "下次清理会做什么",
    nothing_removed: "没有等待删除的已移除测试数据。",
    summary:
      "仍然存在的已移除测试数据：{files} 个文件，{size}。下次清理（每 {minutes} 分钟一次）会删除 {deleteFiles} 个文件（{deleteSize}），保留 {keepFiles} 个（{keepSize}）。",
    kept_because: "保留原因",
    files: "文件数",
    size: "大小",
    file: "文件",
    removed_at: "移除时间",
    next_cleanup: "下次清理",
    why: "原因",
    no_problem: "无数据版本",
    unnamed: "（无名称）",
    version: "版本 #{version}",
    until: "（至 {date}）",
    deleted_user: "已删除的用户",
    used_again: "有题目重新使用了它",
    nothing_needs_it: "已不再需要",
    showing: "显示 {total} 个已移除文件中的 {shown} 个：先列出将删除的，再列出最大的保留文件。",
    actions: {
      Delete: "删除",
      Keep: "在需要期间保留",
      KeepUntil: "保留至 {date}",
      Release: "保留：重新被使用"
    },
    reason_kinds: {
      Grace: "移除不到 15 分钟",
      WaitingSubmission: "等待中的提交",
      WaitingHack: "等待中的 Hack",
      WaitingSelfEval: "等待中的自测",
      Contest: "比赛的保留天数",
      Result: "评测结果的保留天数",
      EarlierResult: "此前评测结果的保留天数",
      Kept: "题目管理者选择保留"
    },
    reasons: {
      Grace: "移除不到 15 分钟",
      WaitingSubmission: "等待中的提交需要{version}",
      WaitingHack: "等待中的 Hack 需要它",
      WaitingSelfEval: "等待中的自测需要它",
      Contest: "比赛 {contest} 用{version}评测",
      Result: "有评测结果用{version}评测",
      EarlierResult: "此前的评测结果用{version}评测",
      Kept: "{username} 保留了{version}"
    }
  },
  judging: {
    title: "评测",
    introduction:
      "评测机如何选择下一个任务。尚未结束的比赛的提交总是最先评测，其次是其他新提交、重测、Hack 和自测，最后是 AI 运行。修改在几秒内生效。",
    fields: {
      contestReservedThreads: "每台评测机为进行中的比赛保留的任务线程数",
      agingMinutes: "等待多少分钟后提前处理"
    },
    notes: {
      contestReservedThreads:
        "比赛进行期间，当评测机的其他任务占满其余线程时，它会为比赛提交留出这么多任务线程，这样长时间的重测或 AI 运行不会拖慢比赛。评测机的任务线程数需要多于这个数才会保留。0 表示不保留。",
      agingMinutes:
        "任务等待超过这个时间后，无论种类，每五个空闲任务线程中会有一个分给它，这样任何任务都不会因为更新的任务而一直等待。比赛提交仍然最先评测。0 表示关闭。"
    },
    invalid: "请输入允许范围内的整数。",
    saved: "评测设置已保存，评测机会在几秒内使用。"
  },
  ai_endpoints: {
    title: "AI 地址",
    introduction:
      "账号的 AI 配置中可以使用哪些服务商、搜索和 MCP 地址。内网或本机地址（例如你网络中的模型服务器）是从本服务器访问的，而不是从用户的浏览器访问，因此需要你批准。站点管理员可以使用任何地址。",
    custom_label: "未批准的地址",
    custom: {
      public: "允许公网地址；内网和本机地址需要批准",
      approved: "只允许已批准的地址"
    },
    custom_notes:
      "只允许已批准的地址时，用户从下面的列表中选择；使用其他地址的配置不会被保存或使用。修改在几秒内生效。",
    approved_title: "已批准的地址",
    none_approved: "没有已批准的地址。",
    name: "向用户显示的名称",
    type: "API",
    base_url: "Base URL",
    remove: "移除",
    remove_named: "移除 {name}",
    add: "添加地址",
    approved_notes:
      "批准的 Base URL 涵盖相同协议、主机和端口下，该路径及其下的所有请求。服务器 HYHOJ_AI_PRIVATE_HOSTS 中列出的主机同样视为已批准。",
    invalid: "每个已批准的地址都需要名称，以及不含密码、查询参数或片段的 http 或 https Base URL。",
    saved: "AI 地址已保存，几秒内生效。",
    usage_title: "使用中的地址",
    usage_introduction: "各账号在 AI 配置中保存的地址，以及它们能否使用。加载时会对每个主机名解析一次。",
    usage_load: "显示使用中的地址",
    usage_reload: "重新加载",
    usage_none: "还没有账号保存 AI 配置。",
    accounts: "账号数",
    accounts_with_administrators: "{count}（其中管理员 {administrators}）",
    status: "状态",
    statuses: {
      approved: "已批准",
      public: "公网地址",
      private: "内网地址：仅管理员可用",
      not_approved: "未批准：仅管理员可用"
    },
    unresolved: "主机名无法解析。",
    approve: "批准",
    approval_unsaved: "已添加到上方，保存后生效。"
  },
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
