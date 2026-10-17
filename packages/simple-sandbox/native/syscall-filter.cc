#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <system_error>
#include <vector>

#include <sched.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>

#include "syscall-filter.h"

#if !defined(__BYTE_ORDER__) || __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#define SYSCALL_FILTER_UNSUPPORTED
#elif defined(__x86_64__)
static const uint32_t nativeArchitecture = AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
static const uint32_t nativeArchitecture = AUDIT_ARCH_AARCH64;
#else
#define SYSCALL_FILTER_UNSUPPORTED
#endif

#ifndef SYSCALL_FILTER_UNSUPPORTED

namespace
{
// Any of these in clone's flags creates a namespace. (CLONE_NEWTIME shares its bit with clone's exit signal and is
// only accepted by clone3 and unshare, which are refused.)
const uint32_t namespaceFlags =
    CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET;
// x32 system calls have this bit set; the sandbox doesn't run x32 programs
const uint32_t x32SyscallBit = 0x40000000;

const uint32_t allow = SECCOMP_RET_ALLOW;
const uint32_t refuse = SECCOMP_RET_ERRNO | EPERM;
const uint32_t notImplemented = SECCOMP_RET_ERRNO | ENOSYS;

SyscallTable NativeSyscallTable()
{
    SyscallTable table;
    table.clone = __NR_clone;
    table.clone3 = __NR_clone3;
#define DENY(name) table.denied.push_back(__NR_##name);
#include "syscall-filter-list.h"
#undef DENY
    return table;
}

// The checks of one table, ending with "allow"; the system call number is loaded first.
std::vector<sock_filter> TableChecks(const SyscallTable &table, bool x32)
{
    // The low 32 bits of clone's first argument, its flags (little-endian)
    const uint32_t cloneFlags = offsetof(struct seccomp_data, args[0]);
    std::vector<sock_filter> checks = {BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr))};
    if (x32)
    {
        checks.push_back(BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, x32SyscallBit, 0, 1));
        checks.push_back(BPF_STMT(BPF_RET | BPF_K, notImplemented));
    }
    checks.insert(checks.end(), {
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, static_cast<uint32_t>(table.clone), 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, cloneFlags),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, namespaceFlags, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, refuse),
        BPF_STMT(BPF_RET | BPF_K, allow),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, static_cast<uint32_t>(table.clone3), 0, 1),
        BPF_STMT(BPF_RET | BPF_K, notImplemented),
    });
    for (int number : table.denied)
    {
        checks.push_back(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, static_cast<uint32_t>(number), 0, 1));
        checks.push_back(BPF_STMT(BPF_RET | BPF_K, refuse));
    }
    checks.push_back(BPF_STMT(BPF_RET | BPF_K, allow));
    return checks;
}

// Runs `checks` for `architecture`, otherwise continues after them. Jump offsets are 8 bits.
void AppendArchitecture(std::vector<sock_filter> &program, uint32_t architecture, const std::vector<sock_filter> &checks)
{
    if (checks.size() > 255)
        throw std::logic_error("The syscall filter has too many checks for one architecture");
    program.push_back(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, architecture, 0, static_cast<uint8_t>(checks.size())));
    program.insert(program.end(), checks.begin(), checks.end());
}
} // namespace

void InstallSyscallFilter()
{
    std::vector<sock_filter> program = {BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch))};
#if defined(__x86_64__)
    AppendArchitecture(program, nativeArchitecture, TableChecks(NativeSyscallTable(), true));
    AppendArchitecture(program, AUDIT_ARCH_I386, TableChecks(I386SyscallTable(), false));
#else
    AppendArchitecture(program, nativeArchitecture, TableChecks(NativeSyscallTable(), false));
#endif
    program.push_back(BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));

    sock_fprog filter = {static_cast<unsigned short>(program.size()), program.data()};
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &filter, 0, 0) != 0)
        throw std::system_error(errno, std::system_category(), "Couldn't install the sandbox's syscall filter");
}

#else

void InstallSyscallFilter()
{
    throw std::runtime_error("The sandbox's syscall filter isn't supported on this architecture; "
                             "set sandbox.syscallFilter to false to run without it");
}

#endif
