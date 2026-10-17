// The system calls the sandbox's filter refuses with EPERM, included once per syscall table (see
// syscall-filter.cc). DENY(name) is defined by the includer; a name the table doesn't have is skipped.
// They create or enter namespaces and mounts, change the system, or widen the kernel's attack surface; programs,
// compilers and language runtimes don't need them. Deliberately no include guard.

// Mounts, root and namespaces (clone and clone3 are checked separately)
#ifdef __NR_mount
DENY(mount)
#endif
#ifdef __NR_umount
DENY(umount)
#endif
#ifdef __NR_umount2
DENY(umount2)
#endif
#ifdef __NR_pivot_root
DENY(pivot_root)
#endif
#ifdef __NR_chroot
DENY(chroot)
#endif
#ifdef __NR_unshare
DENY(unshare)
#endif
#ifdef __NR_setns
DENY(setns)
#endif
#ifdef __NR_open_tree
DENY(open_tree)
#endif
#ifdef __NR_open_tree_attr
DENY(open_tree_attr)
#endif
#ifdef __NR_move_mount
DENY(move_mount)
#endif
#ifdef __NR_fsopen
DENY(fsopen)
#endif
#ifdef __NR_fsconfig
DENY(fsconfig)
#endif
#ifdef __NR_fsmount
DENY(fsmount)
#endif
#ifdef __NR_fspick
DENY(fspick)
#endif
#ifdef __NR_mount_setattr
DENY(mount_setattr)
#endif

// Kernel modules, rebooting and system-wide settings
#ifdef __NR_init_module
DENY(init_module)
#endif
#ifdef __NR_finit_module
DENY(finit_module)
#endif
#ifdef __NR_delete_module
DENY(delete_module)
#endif
#ifdef __NR_create_module
DENY(create_module)
#endif
#ifdef __NR_get_kernel_syms
DENY(get_kernel_syms)
#endif
#ifdef __NR_query_module
DENY(query_module)
#endif
#ifdef __NR_kexec_load
DENY(kexec_load)
#endif
#ifdef __NR_kexec_file_load
DENY(kexec_file_load)
#endif
#ifdef __NR_reboot
DENY(reboot)
#endif
#ifdef __NR_swapon
DENY(swapon)
#endif
#ifdef __NR_swapoff
DENY(swapoff)
#endif
#ifdef __NR_acct
DENY(acct)
#endif
#ifdef __NR_quotactl
DENY(quotactl)
#endif
#ifdef __NR_quotactl_fd
DENY(quotactl_fd)
#endif
#ifdef __NR_iopl
DENY(iopl)
#endif
#ifdef __NR_ioperm
DENY(ioperm)
#endif
#ifdef __NR_vm86
DENY(vm86)
#endif
#ifdef __NR_vm86old
DENY(vm86old)
#endif
#ifdef __NR_syslog
DENY(syslog)
#endif
#ifdef __NR_vhangup
DENY(vhangup)
#endif
#ifdef __NR_settimeofday
DENY(settimeofday)
#endif
#ifdef __NR_stime
DENY(stime)
#endif
#ifdef __NR_clock_settime
DENY(clock_settime)
#endif
#ifdef __NR_clock_settime64
DENY(clock_settime64)
#endif
#ifdef __NR_clock_adjtime
DENY(clock_adjtime)
#endif
#ifdef __NR_clock_adjtime64
DENY(clock_adjtime64)
#endif
#ifdef __NR_adjtimex
DENY(adjtimex)
#endif
#ifdef __NR_sethostname
DENY(sethostname)
#endif
#ifdef __NR_setdomainname
DENY(setdomainname)
#endif
#ifdef __NR_lookup_dcookie
DENY(lookup_dcookie)
#endif
#ifdef __NR_nfsservctl
DENY(nfsservctl)
#endif
#ifdef __NR_uselib
DENY(uselib)
#endif
#ifdef __NR__sysctl
DENY(_sysctl)
#endif

// Kernel attack surface and access to other processes
#ifdef __NR_bpf
DENY(bpf)
#endif
#ifdef __NR_perf_event_open
DENY(perf_event_open)
#endif
#ifdef __NR_userfaultfd
DENY(userfaultfd)
#endif
#ifdef __NR_io_uring_setup
DENY(io_uring_setup)
#endif
#ifdef __NR_io_uring_enter
DENY(io_uring_enter)
#endif
#ifdef __NR_io_uring_register
DENY(io_uring_register)
#endif
#ifdef __NR_keyctl
DENY(keyctl)
#endif
#ifdef __NR_add_key
DENY(add_key)
#endif
#ifdef __NR_request_key
DENY(request_key)
#endif
#ifdef __NR_ptrace
DENY(ptrace)
#endif
#ifdef __NR_process_vm_readv
DENY(process_vm_readv)
#endif
#ifdef __NR_process_vm_writev
DENY(process_vm_writev)
#endif
#ifdef __NR_process_madvise
DENY(process_madvise)
#endif
#ifdef __NR_kcmp
DENY(kcmp)
#endif
#ifdef __NR_pidfd_getfd
DENY(pidfd_getfd)
#endif
#ifdef __NR_open_by_handle_at
DENY(open_by_handle_at)
#endif
#ifdef __NR_name_to_handle_at
DENY(name_to_handle_at)
#endif
#ifdef __NR_fanotify_init
DENY(fanotify_init)
#endif
