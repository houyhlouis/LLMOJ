# 出题指南

简体中文 | [English](Problem-Authoring.md) | [Wiki 首页](Home.md)

本页介绍手动出一道题的全过程：题面、测试数据、四种题目类型各自的评测设置、测试，以及共享或公开。想让 AI 起草题面或生成测试数据，见 [AI](AI.zh-CN.md)；AI 的结果同样按本页的方式编辑。

## 1. 创建题目

在题库中点击**添加题目**。需要**创建题目**权限（见[权限](Permissions.zh-CN.md)）；默认所有登录用户都可以创建题目（`preference.security.allowEveryoneCreateProblem`）。

新题目是**隐藏的**：只有你、管理员和你共享给的人能打开它；设置题目 ID 之前，它在题库中没有编号（见[公开](#6-共享或公开)）。

## 2. 编写题面

**编辑**打开题面编辑器。

- **语言。** 题面可以有多种语言，每种语言有自己的标题和栏目。**设为默认语言**的那种语言会显示给语言没有题面的用户。**添加默认栏目**会加入常用的栏目供填写：题目描述、输入格式、输出格式、样例、数据范围与提示。
- **栏目**分为**文本**（Markdown，用 `$...$` 和 `$$...$$` 写公式）和**样例**。在每个栏目的菜单中移动、添加和删除栏目；空栏目不会显示。
- **样例**属于题目，不属于某种语言：每个样例有输入、输出，以及每种语言各自的解释。**样例**栏目显示其中一个样例。样例编辑器会提示某个样例在某种语言中没有显示或显示了两次。
- **标签**从站点已有的标签中选择。创建和重命名标签需要**管理题目标签**。

样例是题面的一部分。用于评测的数据是分开的（见下一步），不过可以先运行样例（**评测时测试样例**）。

## 3. 上传测试数据

**文件**页有两个列表：

- **测试数据**：评测使用的文件（输入、输出、校验器、交互程序、grader、附加源文件）。除非权限允许（**读取题目测试数据**），用户看不到它们。
- **附加文件**：用户可以在题目页面下载的附件。

测试点命名为 `1.in` 和 `1.out`（或 `1.ans`）、`2.in` 和 `2.out`，依此类推：没有明确设置子任务时，每个有对应 `X.out` 或 `X.ans` 的 `X.in` 都是一个测试点，按文件名中的数字排序。**打包下载**把一个列表下载为 ZIP。修改测试数据或评测设置会产生新的[数据版本](Submissions.zh-CN.md#测试数据版本与此前的评测结果)：提交按提交时的版本评测，**重测**使用当前版本。

## 4. 设置评测方式

**评测设置**页设置题目类型和评测方式。所有设置也可以在**编辑源代码**中以 YAML 编辑，下面的示例就是这种形式。时间以毫秒、内存以 MiB 为单位，不能超过站点的限制（[后端配置](Backend-Configuration.zh-CN.md)中的 `resourceLimit`）。

**题目类型**只能在题目没有提交时切换，切换会把评测设置重置为新类型的默认值（见[更改题目类型](Submissions.zh-CN.md#更改题目类型)）。**允许提交**控制是否接受提交。

### 各类型共有的设置

- **子任务。** `subtasks: null` 自动查找测试点（一个子任务，规则见上文）。明确设置的子任务列出各自的测试点，每个测试点可以有自己的限制和分值。
- **子任务计分方式**（`scoringType`）：`Sum` 把测试点得分相加，`GroupMin` 取最低分，`GroupMul` 把得分相乘（都按占满分的比例计算）。
- **分值**是百分比：子任务占整题的比例，测试点占所在子任务的比例。没有写分值的子任务或测试点平分剩下的分值；写出的分值之和不能超过 100。
- **依赖**（`dependencies: [0, 1]`：子任务的位置，从 0 开始）：所依赖的某个子任务得 0 分时，跳过本子任务，记 0 分。不允许循环依赖。
- **限制**（`timeLimit`、`memoryLimit`）作用于整道题，子任务和测试点可以覆盖它们。

### 校验器

校验器把程序的输出与答案比较（传统题和提交答案题）：

| 校验器 | 接受 |
| --- | --- |
| `integers` | 相同的整数，不论空白如何 |
| `floats` | 在给定相对或绝对误差内的数（`precision: 6` 表示 10⁻⁶） |
| `tokens` | 相同的、以空白分隔的词（可选忽略大小写） |
| `lines` | 相同的行，忽略行末空格和文件末尾的空行（可选忽略大小写） |
| `binary` | 逐字节相同的文件 |
| `custom` | 你自己的程序，随测试数据上传 |

自定义校验器需要写明 `interface`（`testlib`、`legacy`、`lemon`、`hustoj`、`qduoj` 或 `domjudge`：它遵循的约定；常用的是 `testlib`）、`language` 和编译选项、`filename`，并可选地设置自己的 `timeLimit` 和 `memoryLimit`。各种约定的部分分如何计算，见[校验器的分数](Submissions.zh-CN.md#校验器的分数)。

### 传统题

程序读入输入并写出输出，由校验器与答案比较。

```yaml
timeLimit: 1000
memoryLimit: 512
runSamples: true
# fileIo: { inputFilename: game.in, outputFilename: game.out }   # 使用标准输入输出时省略
subtasks:
  - scoringType: GroupMin
    points: 30
    testcases:
      - { inputFile: 1.in, outputFile: 1.out }
      - { inputFile: 2.in, outputFile: 2.out }
  - scoringType: GroupMin
    points: 70
    dependencies: [0]     # 第一个子任务得 0 分时跳过
    testcases:
      - { inputFile: 3.in, outputFile: 3.out }
      - { inputFile: 4.in, outputFile: 4.out, timeLimit: 2000 }
checker:
  type: custom
  interface: testlib
  language: cpp
  compileAndRunOptions: { compiler: g++, std: c++17, O: "2", m: "64" }
  filename: checker.cpp
```

`extraSourceFiles` 按语言在编译时把文件放进程序的源代码目录（`extraSourceFiles: { cpp: { "graph.h": graph.h } }`，键是目标文件名，值是测试数据中的文件）。

### 交互题

程序与你编写的交互程序对话，由交互程序决定结果。没有输出文件。

```yaml
timeLimit: 1000
memoryLimit: 256
runSamples: true
subtasks: null            # 每个 X.in 都是一个测试点
interactor:
  interface: stdio        # 两个程序的输入输出用管道相连
  language: cpp
  compileAndRunOptions: { compiler: g++, std: c++17, O: "2", m: "64" }
  filename: interactor.cpp
  timeLimit: 2000         # 可选；交互程序自己的限制
  memoryLimit: 256
```

使用 `interface: shm` 时，两个程序改为共享一块 `sharedMemorySize` MiB（4 到 128）的内存。省略时，交互程序的限制与题目相同（时间限制不会短于题目的）。新建的交互题时间限制为 1000 ms、内存限制为 512 MiB；站点的限制更低时取站点的限制。

### 提交答案题

用户上传一个包含输出文件的 ZIP，每个测试点一个文件；校验器把每个文件与答案比较。

```yaml
subtasks:
  - scoringType: Sum
    testcases:
      - { inputFile: 1.in, outputFile: 1.out, userOutputFilename: answer1.txt }
      - { inputFile: 2.in, outputFile: 2.out, userOutputFilename: answer2.txt }
checker:
  type: lines
  caseSensitive: false
```

`userOutputFilename` 是该文件在用户 ZIP 中的名称（默认与 `outputFile` 相同）；输入文件是可选的，只传给自定义校验器。把输入文件放在**附加文件**中，用户才能下载它们。ZIP 中可以包含什么，见[答案压缩包](Submissions.zh-CN.md#答案压缩包)。

### 通信题

选手程序的两次独立运行只能通过可信的**管理程序**（由你编写）交换信息：每次运行都只与管理程序对话，从不直接与另一次运行对话。

```yaml
timeLimit: 1000
memoryLimit: 256
runSamples: true
subtasks: null
manager:
  interface: run-twice
  language: cpp
  compileAndRunOptions: { compiler: g++, std: c++17, O: "2", m: "64" }
  filename: manager.cpp
grader:                   # 可选：函数接口
  filename: grader.cpp
```

设置 `grader` 时，选手用 C++ 实现双方的函数，不写 `main`；grader（测试数据中以 `.cpp` 结尾、不叫 `main.cpp` 的文件）提供 `main` 并调用这些函数；比赛页面此时只提供 C++。评测机如何为两次运行准入内存，见[评测配置与扩缩容](Judge-Configuration.zh-CN.md)。

## 5. 测试题目

- 提交一份正确的解法，再提交几份错误的：太慢的、在边界情况答错的、内存超限的。逐一检查结果是否符合预期。
- **统计**汇总题目的提交情况；修改数据后，（有权限时）**重测**用当前数据重新评测之前的提交。
- 比赛管理员可以把自己能编辑的题目在隐藏状态下加入比赛：选手通过比赛看到它。Hack 需要先设置可信 STD（见 [Hack](Hacks.zh-CN.md)）。

## 6. 共享或公开

- **共享**隐藏题目：在题目页面的**权限管理**中给用户或用户组读取权限（可以打开）或写入权限（可以编辑）。所有者能否自己修改这些设置取决于 `preference.security.allowOwnerManageProblemPermission`；哪条规则优先，见[权限](Permissions.zh-CN.md)。
- **公开**题目：**设置题目 ID**（它在题库中的编号），再**设为公开**。两者都需要**设置题目公开状态与编号**权限或**管理题目**特权。题目公开后，只有开启 `preference.security.allowNonPrivilegedUserEditPublicProblem` 时，所有者和有写入权限的人才能继续编辑它。
- **在比赛中**，题目可以有不同的标题、计分权重、自己的输入输出文件名，以及**每个子任务必须全部通过才得分**（见[比赛赛制](Contest-Rules.zh-CN.md)）。这些只改变比赛，不改变题目。
- **删除**会连同提交一起删除题目；只有开启 `preference.security.allowOwnerDeleteProblem` 时，所有者才能删除自己的题目。

## 另见

- [下载题面](Statement-Downloads.zh-CN.md)：以 Markdown 下载题面；以 ZIP 下载比赛题目。
- [题解](Solutions.zh-CN.md)：题目页面上的题解。
- [自测](Self-Evaluation.zh-CN.md)：NOI / OI 比赛中的隐藏预测试。
- [题单与讨论](Study-Lists-and-Discussions.zh-CN.md)：个人题单与讨论管理。
