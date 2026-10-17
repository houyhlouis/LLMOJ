#pragma once

#include <vector>

// The numbers of one system call table's calls that the filter checks.
struct SyscallTable
{
    int clone;
    int clone3;
    std::vector<int> denied;
};

#if defined(__x86_64__)
SyscallTable I386SyscallTable();
#endif

// Installs the sandbox's seccomp filter in the calling process before it executes the sandboxed program:
// - the system calls in syscall-filter-list.h fail with EPERM;
// - clone with any namespace flag fails with EPERM;
// - clone3 fails with ENOSYS, so that C libraries fall back to clone, whose flags the filter can check;
// - on x86-64, x32 system calls fail with ENOSYS, and 32-bit calls (int 0x80, -m32 programs) are checked against
//   their own table; any other architecture is killed.
// Requires PR_SET_NO_NEW_PRIVS. Throws if the filter can't be installed, so that no program runs without it.
void InstallSyscallFilter();
