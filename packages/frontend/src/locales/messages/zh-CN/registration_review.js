return {
  title: "注册审核",
  introduction:
    "审核新用户的注册申请。通过后才创建站点账户并分配用户 ID；待审核和被拒申请不是站点用户。管理员或具有“管理注册审核”权限的用户可查看所有申请的邮箱和审核备注，并可重新批准被拒申请。",
  filter: "申请状态",
  status: {
    pending: "待审核",
    approved: "已通过",
    rejected: "已拒绝",
    all: "全部"
  },
  refresh: "刷新",
  loading: "正在加载注册申请…",
  empty: "当前筛选下没有注册申请。",
  account: "申请用户名 / 邮箱",
  user_id: "用户 ID：{id}",
  registered: "申请时间",
  state: "状态",
  review: "审核记录",
  actions: "操作",
  reviewer: "审核人 #{id}",
  approve: "通过",
  reject: "拒绝",
  previous: "上一页",
  next: "下一页",
  pagination: "第 {page} / {pages} 页，共 {count} 条",
  confirm_approve: "通过 {username} 的注册申请",
  confirm_reject: "拒绝 {username} 的注册申请",
  confirm_reapprove: "重新通过 {username} 的注册申请",
  reapprove_notice:
    "此申请此前已被拒绝。通过后将创建站点账户，申请人可使用注册时的密码登录。本次审核人、审核时间和备注将被记录，请确认此前的拒绝原因已解决。",
  final_decision:
    "提交后将记录本次审核人、审核时间和备注。被拒绝的申请以后可以重新批准；已通过的申请不能在此改为拒绝。请核对后确认。",
  note: "审核备注（选填，最多 500 字符，仅有审核权限的用户可见）",
  cancel: "取消",
  confirm: "确认审核",
  load_failed: "加载失败，请点击刷新重试。",
  save_failed: "未能确认审核结果，请刷新列表确认后重试。",
  success: {
    approved: "已通过注册申请并创建站点账户，该用户现在可以登录。",
    rejected: "已拒绝注册申请，未创建站点账户。"
  },
  errors: {
    DUPLICATE_USERNAME: "申请中的用户名已被占用，暂时无法通过。申请状态保持不变，请核对后重试。",
    DUPLICATE_EMAIL: "申请中的邮箱已被占用，暂时无法通过。申请状态保持不变，请核对后重试。",
    PERMISSION_DENIED: "你没有管理注册审核的权限。请联系管理员授权；授权后刷新页面。",
    NO_SUCH_APPLICATION: "此注册申请已不存在，请刷新列表。",
    ALREADY_REVIEWED: "此申请的状态已改变，或不允许执行此操作。已通过的申请不能改为拒绝。列表已刷新，请关闭窗口查看。"
  }
};
