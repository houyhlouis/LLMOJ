#include <string>
#include <iostream>
#include <exception>
#include <functional>
#include <system_error>
#include <vector>
#include <stdexcept>
#include <memory>
#include <mutex>
#include <algorithm>

#include <cstring>
#include <cassert>

#include <filesystem>

#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <unistd.h>
#include <sys/types.h>
#include <syscall.h>
#include <grp.h>
#include <sys/time.h>
#include <sys/resource.h>
#include <sys/mount.h>
#include <sys/wait.h>
#include <sys/prctl.h>
#include <sys/resource.h>

#include <fmt/format.h>
#include <fmt/ostream.h>
#if FMT_VERSION >= 90000
#include <fmt/std.h>
#endif

#include "sandbox.h"
#include "utils.h"
#include "cgroup.h"
#include "semaphore.h"
#include "pipe.h"
#include "io-redirection.h"
#include "syscall-filter.h"

namespace fs = std::filesystem;
using std::string;
using std::vector;
using fmt::format;


class SandboxExecution
{
public:
    SandboxParameter parameter;

    PosixSemaphore semaphore1, semaphore2;
    // This pipe is used to forward error message from the child process to the parent.
    PosixPipe pipefd;
    Cgroup cgroup;
    pid_t pid = -1;
    bool reaped = false;

    SandboxExecution(const SandboxParameter &param, int pipeOptions)
        : parameter(param), semaphore1(true, 0), semaphore2(true, 0), pipefd(pipeOptions),
          cgroup(param.memoryLimit, param.processLimit)
    {
    }
};

static void EnsureDirectoryExistance(fs::path dir) {
    if (!fs::exists(dir))
    {
        throw std::runtime_error((format("The specified path {} does not exist.", dir)));
    }
    if (!fs::is_directory(dir))
    {
        throw std::runtime_error((format("The specified path {} exists, but is not a directory.", dir)));
    }
}

void GetUserEntryInSandbox(const fs::path &rootfs, const std::string username, std::vector<char> &dataBuffer, passwd &entry) {
    auto passwdFilePath = rootfs / "etc" / "passwd";
    std::unique_ptr<FILE, FileCloser> passwdFile(fopen(passwdFilePath.c_str(), "r"));
    if (passwdFile == nullptr)
        throw std::system_error(errno, std::system_category(), "Couldn't open /etc/passwd in rootfs");

    long passwdBufferSize = sysconf(_SC_GETPW_R_SIZE_MAX);
    if (passwdBufferSize == -1) passwdBufferSize = 16384;
    dataBuffer.resize(passwdBufferSize);

    passwd *user = nullptr;
    while (fgetpwent_r(passwdFile.get(), &entry, dataBuffer.data(), passwdBufferSize, &user) == 0)
        if (username == user->pw_name)
            break;

    if (user == nullptr)
        if (errno == ENOENT)
            throw std::invalid_argument(format("No such user: {}", username));
        else
            throw std::system_error(errno, std::system_category(), "fgetpwent_r");
}

// Opens `relative` under the directory `root` as an O_PATH descriptor without following any symbolic link in it.
static int OpenBeneath(const fs::path &root, const std::string &relative)
{
    int fd = ENSURE(open(root.c_str(), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    size_t start = 0;
    while (!relative.empty() && start <= relative.size())
    {
        auto end = relative.find('/', start);
        if (end == string::npos)
            end = relative.size();
        const auto component = relative.substr(start, end - start);
        start = end + 1;
        if (component.empty() || component == "." || component == "..")
        {
            close(fd);
            throw std::invalid_argument(format("Invalid mount source component in {}", relative));
        }
        const int next = openat(fd, component.c_str(), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        const int error = errno;
        close(fd);
        if (next == -1)
            throw std::system_error(error, std::system_category(), format("Cannot open mount source {}", relative));
        fd = next;
    }
    return fd;
}

// Moves a descriptor to the lowest free number at or above `minimum`.
static int MoveDescriptor(int descriptor, int minimum)
{
    const int moved = ENSURE(fcntl(descriptor, F_DUPFD_CLOEXEC, minimum));
    ENSURE(close(descriptor));
    return moved;
}

// Places the passed descriptors at the numbers the program expects. The child's own descriptors that are still in use
// (the error pipe and /dev/null) move above every number involved first, so that no placement replaces them.
static void PlaceDescriptors(const SandboxParameter &parameter, int &errorPipe, int &nullfd)
{
    int minimum = std::max({3, errorPipe, nullfd}) + 1;
    for (const auto &[source, target] : parameter.descriptors)
        minimum = std::max({minimum, source + 1, target + 1});
    errorPipe = MoveDescriptor(errorPipe, minimum);
    nullfd = MoveDescriptor(nullfd, minimum);

    // Copies first: a descriptor's target may be another descriptor's source.
    vector<int> copies;
    for (const auto &[source, target] : parameter.descriptors)
        copies.push_back(ENSURE(fcntl(source, F_DUPFD_CLOEXEC, minimum)));
    for (size_t i = 0; i < copies.size(); i++)
    {
        // dup2 leaves the target without FD_CLOEXEC, so it stays open in the program.
        ENSURE(dup2(copies[i], parameter.descriptors[i].second));
        ENSURE(close(copies[i]));
    }
}

static int ChildProcess(void *param_ptr)
{
    SandboxExecution &execParam = *reinterpret_cast<SandboxExecution *>(param_ptr);
    // We obtain a full copy of parameters here. The arguments may be destoryed after some time.
    SandboxParameter parameter = execParam.parameter;
    int errorPipe = execParam.pipefd[1];

    try
    {
        ENSURE(close(execParam.pipefd[0]));

        if (!execParam.parameter.cpuAffinity.empty()) {
            cpu_set_t mask;
            CPU_ZERO(&mask);
            for (auto cpu : execParam.parameter.cpuAffinity)
                CPU_SET(cpu, &mask);
            ENSURE(sched_setaffinity(0, sizeof(cpu_set_t), &mask));
        }

        int nullfd = ENSURE(open("/dev/null", O_RDWR | O_CLOEXEC));
        if (parameter.redirectBeforeChroot)
        {
            if (!parameter.descriptors.empty())
                throw std::invalid_argument("Passed descriptors require redirection after chroot.");
            RedirectIO(parameter, nullfd);
        }

        ENSURE(mount("none", "/", NULL, MS_REC | MS_PRIVATE, NULL)); // Make root private

        EnsureDirectoryExistance(parameter.chrootDirectory);
        ENSURE(mount(parameter.chrootDirectory.string().c_str(),
                     parameter.chrootDirectory.string().c_str(), "", MS_BIND | MS_RDONLY | MS_REC, ""));
        ENSURE(mount("", parameter.chrootDirectory.string().c_str(), "", MS_BIND | MS_REMOUNT | MS_RDONLY | MS_REC, ""));

        for (MountInfo &info : parameter.mounts)
        {
            if (!info.dst.is_absolute()) {
                throw std::invalid_argument(format("The dst path {} in mounts should be absolute.", info.dst));
            }

            fs::path target = parameter.chrootDirectory / std::filesystem::relative(info.dst, "/");

            // A pinned source is mounted through its descriptor: exactly the directory opened, in this namespace
            const int pinned = info.beneath ? OpenBeneath(info.src, info.beneathPath) : -1;
            const fs::path source = pinned == -1 ? info.src : fs::path(format("/proc/self/fd/{}", pinned));
            EnsureDirectoryExistance(source);
            EnsureDirectoryExistance(target);
            ENSURE(mount(source.string().c_str(), target.string().c_str(), "", MS_BIND | MS_REC, ""));
            if (pinned != -1)
                ENSURE(close(pinned));
            if (info.limit == 0)
            {
                ENSURE(mount("", target.string().c_str(), "", MS_BIND | MS_REMOUNT | MS_RDONLY | MS_REC, ""));
            }
            else if (info.limit != -1)
            {
                // Size limits are not implemented. Refuse rather than silently mounting without one;
                // limit writable space with a size-limited filesystem (e.g. tmpfs) instead.
                throw std::invalid_argument(format("Size limit {} for mount {} is not supported.", info.limit, info.dst));
            }
        }

        ENSURE(chroot(parameter.chrootDirectory.string().c_str()));
        ENSURE(chdir(parameter.workingDirectory.string().c_str()));

        if (parameter.mountProc)
        {
            ENSURE(mount("proc", "/proc", "proc", 0, NULL));
        }
        if (!parameter.descriptors.empty())
        {
            // After the mounts, whose sources may be /proc/self/fd paths of this process's descriptors
            PlaceDescriptors(parameter, errorPipe, nullfd);
        }
        if (!parameter.redirectBeforeChroot)
        {
            RedirectIO(parameter, nullfd);
        }

        if (!parameter.hostname.empty()) {
            ENSURE(sethostname(parameter.hostname.c_str(), parameter.hostname.length()));
        }

        if (parameter.stackSize != -2)
        {
            rlimit64 rlim;
            rlim.rlim_max = rlim.rlim_cur = parameter.stackSize != -1 ? parameter.stackSize : RLIM64_INFINITY;
            ENSURE(setrlimit64(RLIMIT_STACK, &rlim));
        }

        {
            rlimit rlim;
            rlim.rlim_max = rlim.rlim_cur = 0;
            ENSURE(setrlimit(RLIMIT_CORE, &rlim));
        }

        if (parameter.addressSpaceLimit > 0) {
            rlimit rlim;
            rlim.rlim_max = rlim.rlim_cur = parameter.addressSpaceLimit;
            ENSURE(setrlimit(RLIMIT_AS, &rlim));
        }

        gid_t groupList[1];
        groupList[0] = parameter.gid;
        ENSURE(syscall(SYS_setgid, parameter.gid));
        ENSURE(syscall(SYS_setgroups, 1, groupList));
        ENSURE(syscall(SYS_setuid, parameter.uid));
        // A full distribution includes setuid executables; disallow all exec-time privilege gains.
        ENSURE(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));
        // Last, so that it covers the program and everything it starts; a failure is reported like any other.
        if (parameter.syscallFilter)
            InstallSyscallFilter();

        vector<char *> params = StringToPtr(parameter.executableParameters),
                       envi = StringToPtr(parameter.environmentVariables);

        int temp = -1;
        // Inform the parent that no exception occurred.
        ENSURE(write(errorPipe, &temp, sizeof(int)));

        // Inform our parent that we are ready to go.
        execParam.semaphore1.Post();
        // Wait for parent's reply.
        execParam.semaphore2.Wait();

        ENSURE(execvpe(parameter.executable.c_str(), &params[0], &envi[0]));

        // If execvpe returns, then we meet an error.
        return 1;
    }
    catch (std::exception &err)
    {
        const char *errMessage = err.what();
        int len = strlen(errMessage);
        try
        {
            ENSURE(write(errorPipe, &len, sizeof(int)));
            ENSURE(write(errorPipe, errMessage, len));
            ENSURE(close(errorPipe));
            execParam.semaphore1.Post();
            return 1;
        }
        catch (...)
        {
            assert(false);
        }
    }
    catch (...)
    {
        assert(false);
    }

    return 1;
}

// The child stack is only used before `execvpe`, so it does not need much space.
const int childStackSize = 1024 * 700;
SandboxExecutionHandle StartSandbox(const SandboxParameter &parameter)
{
    auto execution = std::make_shared<SandboxExecution>(parameter, O_CLOEXEC | O_NONBLOCK);
    try
    {
        // char* childStack = new char[childStackSize];
        std::vector<char> childStack(childStackSize); // I don't want to call `delete`

        execution->pid = ENSURE(clone(ChildProcess, childStack.data() + childStack.size(),
                                      CLONE_NEWNET | CLONE_NEWUTS | CLONE_NEWPID | CLONE_NEWNS | CLONE_NEWIPC | SIGCHLD,
                                      const_cast<void *>(reinterpret_cast<const void *>(execution.get()))));
        // Wait for at most 500ms. If the child process hasn't posted the semaphore,
        // We will assume that the child has already dead.
        bool waitResult = execution->semaphore1.TimedWait(500);

        int errLen, bytesRead = read(execution->pipefd[0], &errLen, sizeof(int));
        // Child will be killed once the error has been thrown.
        if (!waitResult || bytesRead == 0 || bytesRead == -1)
        {
            const auto waitResult = waitpid(execution->pid, nullptr, WNOHANG);
            if (waitResult == 0)
            {
                // The child process is still alive.
                throw std::runtime_error("The child process is not responding.");
            }
            if (waitResult == execution->pid)
                execution->reaped = true;
            else if (waitResult == -1)
                throw std::system_error(errno, std::system_category(), "Cannot inspect the failed sandbox child");
            // The child process exited with no information available.
            throw std::runtime_error("The child process has exited unexpectedly.");
        }
        else if (errLen != -1) // -1 indicates OK.
        {
            vector<char> buf(errLen);
            ENSURE(read(execution->pipefd[0], &*buf.begin(), errLen));
            string errstr(buf.begin(), buf.end());
            throw std::runtime_error((format("The child process has reported the following error: {}", errstr)));
        }

        execution->cgroup.Attach(execution->pid);
        // Continue the child.
        execution->semaphore2.Post();

        return execution;
    }
    catch (...)
    {
        const auto failure = std::current_exception();
        vector<string> cleanupFailures;
        if (execution->pid != -1 && !execution->reaped)
        {
            if (kill(execution->pid, SIGKILL) == -1 && errno != ESRCH)
                cleanupFailures.push_back(std::system_error(errno, std::system_category(), "Cannot kill sandbox child").what());

            while (true)
            {
                const auto waitResult = waitpid(execution->pid, nullptr, 0);
                if (waitResult == execution->pid)
                {
                    execution->reaped = true;
                    break;
                }
                if (waitResult == -1 && errno == EINTR)
                    continue;
                if (waitResult == -1 && errno == ECHILD)
                {
                    execution->reaped = true;
                    break;
                }
                if (waitResult == -1)
                    cleanupFailures.push_back(
                        std::system_error(errno, std::system_category(), "Cannot reap sandbox child").what());
                break;
            }
        }
        try
        {
            execution->cgroup.Remove();
        }
        catch (const std::exception &cleanupError)
        {
            cleanupFailures.push_back(cleanupError.what());
        }

        if (!cleanupFailures.empty())
        {
            string cleanupMessage;
            for (const auto &cleanupFailure : cleanupFailures)
            {
                if (!cleanupMessage.empty())
                    cleanupMessage += "; ";
                cleanupMessage += cleanupFailure;
            }
            try
            {
                std::rethrow_exception(failure);
            }
            catch (...)
            {
                std::throw_with_nested(std::runtime_error(format("Sandbox startup cleanup failed: {}", cleanupMessage)));
            }
        }
        std::rethrow_exception(failure);
    }
}

ExecutionResult
WaitForProcess(const SandboxExecutionHandle &execution)
{
    ExecutionResult result;
    int status;
    rusage usage{};
    ENSURE(wait4(execution->pid, &status, 0, &usage));
    result.userCpuTimeNanoseconds = uint64_t(usage.ru_utime.tv_sec) * 1000000000ULL + uint64_t(usage.ru_utime.tv_usec) * 1000ULL;
    execution->reaped = true;

    // Try reading error message first
    int errLen, bytesRead = read(execution->pipefd[0], &errLen, sizeof(int));
    if (bytesRead > 0)
    {
        vector<char> buf(errLen);
        ENSURE(read(execution->pipefd[0], &*buf.begin(), errLen));
        string errstr(buf.begin(), buf.end());
        throw std::runtime_error((format("The child process has reported the following error: {}", errstr)));
    }

    if (WIFEXITED(status))
    {
        result.status = EXITED;
        result.code = WEXITSTATUS(status);
    }
    else if (WIFSIGNALED(status))
    {
        result.status = SIGNALED;
        result.code = WTERMSIG(status);
    }
    return result;
}

pid_t GetSandboxPid(const SandboxExecutionHandle &execution)
{
    return execution->pid;
}

CgroupStats ReadSandboxStats(const SandboxExecutionHandle &execution)
{
    return execution->cgroup.ReadStats();
}

CgroupStats FinalizeSandboxCgroup(const SandboxExecutionHandle &execution)
{
    return execution->cgroup.Finalize();
}

void KillSandbox(const SandboxExecutionHandle &execution)
{
    execution->cgroup.Kill();
}

void RemoveSandboxCgroup(const SandboxExecutionHandle &execution)
{
    execution->cgroup.Remove();
}
