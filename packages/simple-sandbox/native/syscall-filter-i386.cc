// The 32-bit x86 numbers of the system calls the sandbox's filter checks. A 64-bit process can make these calls
// too (int 0x80), and C/C++ programs may be compiled with -m32. Kept in their own translation unit: the 32-bit
// <asm/unistd_32.h> and the native <sys/syscall.h> define the same names.
#if defined(__x86_64__)

// First, before any header that could include the 64-bit numbers
#include <asm/unistd_32.h>

#include <vector>

#include "syscall-filter.h"

static_assert(__NR_clone == 120 && __NR_ptrace == 26, "The 32-bit x86 system call table is required here");

SyscallTable I386SyscallTable()
{
    SyscallTable table;
    table.clone = __NR_clone;
    table.clone3 = __NR_clone3;
#define DENY(name) table.denied.push_back(__NR_##name);
#include "syscall-filter-list.h"
#undef DENY
    return table;
}

#endif
