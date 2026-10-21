# 运维手册

简体中文 | [English](Runbook.md) | [Wiki 首页](Home.md)

[doctor](Operations-Configuration.zh-CN.md#运行-doctor) 发出警告或失败、[指标](Operations-Configuration.zh-CN.md#指标)越过界线，或用户报告问题时该怎么办。先运行：

```bash
sudo bash /opt/LLMOJ/deploy/doctor.zh-CN.sh
```

doctor 只读取。下面每节列出 doctor 的提示、含义以及处理方法。大多数问题的详情在后端日志中（`sudo journalctl -u libreoj-backend --since "1 hour ago"`）；用户报告的错误编号可以找到对应的日志行（`grep '编号'`）。

## 网站无法访问或未就绪

**“后端在端口……无响应”**或**“后端未就绪”**
- `sudo systemctl status libreoj-backend` 显示它是否在运行。如果它反复重启，请查看日志。
- **日志中有 “The database lacks what this release needs”**：数据库比代码旧，例如恢复了较旧版本的备份。请运行升级器，或恢复与已安装版本相符的备份。见[启动时检查数据库](Upgrade.zh-CN.md#启动时检查数据库)。
- **日志说配置无效**：最近对 `config/backend.yaml` 的修改有误。撤销修改并重启后端。

**“后端无法连接数据库 / Redis / 对象存储”**：该服务已停止。请参阅下面对应的小节，然后再次检查；后端会自行重新连接。

**“Nginx 在端口……未把请求转发给后端”**：`sudo systemctl status libreoj-nginx`。修改 `config/nginx.conf` 后，请按 [Nginx](Operations-Configuration.zh-CN.md#nginxconfignginxconf) 中的说明先检查再重新加载。

**“证书……将在 N 天后过期”**或**“已过期”**：请续期（[HTTPS](HTTPS.zh-CN.md)）。浏览器会拒绝已过期的证书。

## Redis

**“Redis 无响应”**：`sudo systemctl status libreoj-redis`。在它恢复之前，用户会被登出，实时更新也会停止；排队的评测保存在数据库中，不会丢失。

**“Redis 无法把数据写入磁盘”**：通常是磁盘已满。请释放空间（见[服务器](#服务器)）；Redis 会自行重试。

**“Redis 用满后会淘汰键”**：在 `config/redis.conf` 中设置安装时的 `maxmemory-policy noeviction`（[Redis](Operations-Configuration.zh-CN.md#redisconfigredisconf)），然后重启 Redis。淘汰键可能丢失会话和排队的工作。

**“Redis 有 N 个连接”**：有程序不断打开连接。`sudo systemctl restart libreoj-backend` 会释放它们；请连同版本号报告此问题，这是缺陷。

## 数据库与对象存储

**“MariaDB 未在其套接字上响应”**：`sudo systemctl status libreoj-mariadb` 和 `sudo journalctl -u libreoj-mariadb`。通常是磁盘已满。

**“MariaDB 已使用 N/M 个连接”**：请求激增，或有查询没有结束。如果持续如此，请重启后端，然后在其日志中查找慢查询（`LIBREOJ_SLOW_QUERY_MS`）。

**“MinIO 无响应”**：`sudo systemctl status libreoj-minio`。在它恢复之前，上传、下载以及需要下载测试数据的评测都会停止。

**“数据库与当前版本的定义有 N 处不同”**：后端仍可运行，但某列的定义不同或缺少索引，因此有些页面可能更慢，或约束更少。后端启动时会在日志中列出最先发现的差异。如果是升级留下的，请附上该日志报告。

## 评测

**“已连接的 N 台评测机均在排空”**：不会评测新提交。在 **评测机状态** 页面，对处理完毕的评测机点击播放图标（**恢复**）。

**“N 个提交在等待；最早的已等待……”**
- **没有已连接的评测机**（`libreoj_judge_clients` 指标，或 **评测机状态** 页面）：启动评测机（`sudo systemctl start libreoj-judge`），或查看远程评测机的日志。
- **已连接但很忙**：重测或 AI 运行可能占用了线程。[下一个任务是哪个](Distributed-Judging.zh-CN.md#下一个任务是哪个)说明了顺序。增加评测槽（[评测机配置](Judge-Configuration.zh-CN.md#修改评测槽数量)）或评测机。

**“N 个进行中比赛的提交在等待”**：比赛提交本就最先评测，说明所有线程都在处理耗时的任务。在 **站点管理** → **评测** 中，为进行中的比赛在每台评测机上保留一两个任务线程。

**“N 个评测任务失去了评测机”**：某个后端进程在其评测机工作时停止了。这些任务会在约 15 秒内重新排队；如果数量一直不变，后端可能在反复停止，请查看其日志。

**“过去一天有 N 个评测任务失败”**：在 **评测机状态** 页面的 **评测队列** 中查看每个任务的原因。任务在中断 5 次（例如导致评测机崩溃的提交）或准备失败 10 次（例如缺少测试数据）后失败，其提交显示 **System Error**。修正原因后重测。

**“沙箱镜像与 config/judge.yaml 不一致”**、**“评测无法限制……”**或**“N 个评测工作目录未挂载”**：评测机安装后的设置发生了变化。[修改评测槽数量](Judge-Configuration.zh-CN.md#修改评测槽数量)（即使改为当前数量）会重新设置其工作目录和服务；然后运行 `sudo bash /opt/LLMOJ/deploy/sandbox/self-test.sh`。

## 统计数据

**“题目和用户的统计数据落后提交……”**：统计变化会在一分钟内应用。如果一直落后，请查看后端日志，然后用 `deploy/rebuild-statistics.sh` 检查并修正（[提交数与通过数](Operations-Configuration.zh-CN.md#提交数与通过数)）。

## AI

**“N 个 AI 任务在等待”**
- **AI 已在站点管理中暂停**：准备好后恢复。
- **限额已满**：`libreoj_ai_provider_requests{state="waiting"}` 持续增长。在 **站点管理** 中提高 **同时进行的 AI 请求数**，或等待。
- **服务商出错**：用户能在任务上看到原因，AI 配置页面的 **用量** 会统计失败的请求。

**“AI 运行器套接字不存在”**：本服务器上的评测机负责运行 AI 程序。请启动它（`sudo systemctl start libreoj-judge`）。

**“AI 任务调度出错 N 次”**：查看后端日志；每种错误每分钟记录一次。

**“过去一天有 N 个 AI 请求没有报告用量”**：服务商不报告 token 用量，因此每个这样的请求都按最大值计入预算，账号会更快达到上限。请选择报告用量的服务商或 API 格式，或提高限额。

**用户收到“内网或本机 API 地址需要站点管理员在‘站点管理’中批准后才能使用”**或**“本站只允许使用站点管理员批准的 API 地址”**：在 **站点管理** → **AI 地址** → **使用中的地址** 中检查该地址，如果确实需要使用就批准它（[账号可以使用哪些地址](AI.zh-CN.md#账号可以使用哪些地址)）。

## 服务器

**磁盘空间或文件条目（inode）不足**：通常是 `backups/upgrade` 中的旧升级备份（doctor 会说明它们占用多少）；删除不再需要的。其次是 `backups/` 中的旧备份（`backup.sh --keep` 会替你删除），然后是日志（`sudo journalctl --vacuum-time=30d`）。

**可用内存不足**：大部分内存由评测机的内存预算（[评测机配置](Judge-Configuration.zh-CN.md)）和评测槽数量决定。请减少评测槽，或增加内存。

**“系统时间未同步”**：`sudo timedatectl set-ntp true`。验证器动态码和会话时间都依赖它。

## 备份

**“没有用 deploy/backup.sh 做过备份”**或最近一次备份已经很旧：运行 `sudo bash /opt/LLMOJ/deploy/backup.sh`，并定期执行（[备份](Operations-Configuration.zh-CN.md#备份)中有每晚定时任务的示例）。

**`verify-backup.sh` 失败**
- **“与其 .sha256 校验值不符”**：副本已损坏或不完整。请重新复制，或使用其他备份。
- **“无法解密”**：在进行检查的机器上导入该备份加密所用的私钥。
- **“存储中缺少文件”**或**“与记录的内容哈希不符”**：做备份时网站的存储已经损坏，或副本损坏。请用一个新备份检查网站自身的存储；从包含这些文件的较早备份中恢复缺少的文件。
- **“data/ai/master.key 无法解密”**：该密钥文件不属于这个数据库。恢复后的网站将无法读取已保存的 AI 设置。请找到匹配的密钥；否则用户需要重新填写各自的密钥。

## 升级

**“升级……中途停止”**：见[升级失败时](Upgrade.zh-CN.md#升级失败时)：修正原因后用相同的选项再次运行升级器，或[回滚](Upgrade.zh-CN.md#回滚)。
