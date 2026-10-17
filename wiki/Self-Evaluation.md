# Self Eval in NOI / OI contests

[简体中文](Self-Evaluation.zh-CN.md) | English | [Wiki home](Home.en.md)

Self Eval lets contestants test their code on a small set of hidden pretests during a contest. It exists **only in NOI / OI contests**, and only when the contest's manager turns it on; it's off by default. IOI, Strict IOI and ICPC contests, ordinary problem pages and submission pages don't have it.

During the contest, open a contest problem and click **Self Eval**. Enter your code, choose a language and compiler options the contest allows, and click **Run Self Eval**. You see the status, score, subtask scores, time and memory, and nothing else: the pretest input, expected output, your program's output, compiler messages and checker messages stay hidden. A Self Eval run isn't a submission: it doesn't change official scores, accepted counts or the scoreboard. Official NOI / OI results stay hidden as the contest rule requires.

## Turning it on

1. Edit the contest, choose the **NOI / OI** rule, tick **Enable Self Eval** and set the maximum number of runs per participant, then save. The default is 30 runs per participant for the whole contest, shared by all its problems; you can set 1 to 1000.
2. Add a traditional problem to the contest, open it from the contest, click **Self Eval** and go to **Configure Self Eval**.
3. Enter **make.cpp** (the generator) and **std.cpp** (the standard solution) that produced the problem's current official test data. Both are compiled as C++17, and each may be up to 1 MiB.
4. Check the subtask IDs. If std.cpp reads and writes files, tick **std.cpp uses file I/O** and enter its file names.
5. Tick the confirmation that these programs generated the current official data, then click **Save make.cpp / std.cpp**.
6. Click **Prepare pretest data** and refresh until the set is Ready.

Steps 5 and 6 must be finished before the contest starts.

Configuring Self Eval needs permission to manage the contest, edit the problem and edit its test data. Contestants need permission to take part in the contest, submit to the problem and run self-evaluations. The usual contest, problem and team access rules still apply.

The saved programs are kept as fixed versions. Pretests are judged with **the problem's own checker or special judge, so there's nothing extra to configure**. If AI generation attached an input validator to the problem's data, the pretests use it too.

make.cpp receives `subtaskId seed` both as command-line arguments and as one line on standard input, and prints one complete test input. std.cpp reads that input and prints the expected answer. Each problem in each contest gets one pretest set, the same for every contestant.

## Generating the programs with AI

**Configure Self Eval** also has a button **AI: generate official data and Self Eval programs**. It needs permission to use AI and to generate test data, a configured AI service and a working judge. It runs the usual official-data generation, which **replaces the problem's official test data**, and saves the matching make.cpp, std.cpp and validator.

When it finishes, the generated programs appear in the configuration and you click **Prepare pretest data**. Generating official data from the ordinary problem editor also saves the programs for later NOI / OI contests; it doesn't add Self Eval to the problem set.

## Limits

- Each participant has 30 runs for the whole contest by default, shared by all its problems; the count doesn't reset daily.
- Runs are possible only while the contest is running. Every run counts once it starts, whatever the result, including compile errors, wrong answers, time-outs and judge errors.
- Runs refused for invalid input, missing permission, missing data or failed preparation don't count.
- Each account can have at most three runs waiting at once, and simultaneous requests can't go over the limit.
- A set has at most 20 subtasks, with one generated test for each configured subtask. Each input and each expected output may be up to 4 MiB, and the whole set up to 16 MiB.

These limits are LLMOJ settings, not the rules of any particular NOI event. Passing Self Eval doesn't guarantee full marks in official judging.

Changing the problem's judge settings or the saved programs invalidates a prepared set. Once contestants have used a set in a contest, it can't be replaced there, so that everyone is tested on the same data. Sets can't be configured or prepared after the contest starts.
