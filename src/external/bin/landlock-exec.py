#!/usr/bin/env python3
"""Run a command confined by Linux Landlock (unprivileged; no capabilities or namespaces needed). TB-058.

    landlock-exec.py [--ro PATH]... [--rw PATH]... [--tcp-connect PORT]... -- COMMAND [ARGS...]

Everything the kernel's Landlock ABI can restrict is handled: file system access is denied except read (and execute)
beneath each --ro path and read/write beneath each --rw path; TCP connect is denied except to the --tcp-connect ports;
TCP bind is denied; abstract Unix sockets and signals are scoped to the confined processes (ABI 6+). The restriction is
inherited by every child and cannot be lifted. Exits 3 without running COMMAND if the kernel cannot enforce TCP rules
(ABI < 4), so a run never proceeds unconfined.
"""
import ctypes
import os
import sys

SYS_CREATE, SYS_ADD_RULE, SYS_RESTRICT = 444, 445, 446  # the same on x86_64 and aarch64
RULE_PATH_BENEATH, RULE_NET_PORT = 1, 2
FS = dict(execute=1 << 0, write_file=1 << 1, read_file=1 << 2, read_dir=1 << 3, remove_dir=1 << 4, remove_file=1 << 5,
          make_char=1 << 6, make_dir=1 << 7, make_reg=1 << 8, make_sock=1 << 9, make_fifo=1 << 10, make_block=1 << 11,
          make_sym=1 << 12, refer=1 << 13, truncate=1 << 14, ioctl_dev=1 << 15)
FILE_ONLY = FS['execute'] | FS['write_file'] | FS['read_file'] | FS['truncate'] | FS['ioctl_dev']
NET_BIND, NET_CONNECT = 1 << 0, 1 << 1
SCOPE_ABSTRACT_UNIX, SCOPE_SIGNAL = 1 << 0, 1 << 1


class RulesetAttr(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64), ('handled_access_net', ctypes.c_uint64), ('scoped', ctypes.c_uint64)]


class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]


class NetPort(ctypes.Structure):
    _fields_ = [('allowed_access', ctypes.c_uint64), ('port', ctypes.c_uint64)]


def fail(msg: str, code: int = 3):
    print(f'landlock-exec: {msg}', file=sys.stderr)
    sys.exit(code)


def main(argv: list[str]):
    if '--' not in argv:
        fail('usage: landlock-exec.py [--ro P]... [--rw P]... [--tcp-connect PORT]... -- COMMAND [ARGS...]', 2)
    i = argv.index('--')
    opts, command = argv[:i], argv[i + 1:]
    ro, rw, ports = [], [], []
    for flag, value in zip(opts[::2], opts[1::2]):
        {'--ro': ro, '--rw': rw, '--tcp-connect': ports}[flag].append(value)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    abi = libc.syscall(SYS_CREATE, None, ctypes.c_size_t(0), ctypes.c_uint32(1))
    if abi < 4:
        fail(f'kernel Landlock ABI {abi} cannot restrict TCP; refusing to run unconfined')
    fs = 0
    for name, bit in FS.items():
        if name == 'refer' and abi < 2 or name == 'truncate' and abi < 3 or name == 'ioctl_dev' and abi < 5:
            continue
        fs |= bit
    attr = RulesetAttr(fs, NET_BIND | NET_CONNECT, SCOPE_ABSTRACT_UNIX | SCOPE_SIGNAL if abi >= 6 else 0)
    size = ctypes.sizeof(RulesetAttr) if abi >= 6 else 16
    fd = libc.syscall(SYS_CREATE, ctypes.byref(attr), ctypes.c_size_t(size), ctypes.c_uint32(0))
    if fd < 0:
        fail(f'landlock_create_ruleset failed: {os.strerror(ctypes.get_errno())}')
    read = FS['execute'] | FS['read_file'] | FS['read_dir']
    for paths, access in ((ro, read), (rw, fs)):
        for p in paths:
            if not os.path.exists(p):
                continue
            pfd = os.open(p, os.O_PATH | os.O_CLOEXEC)
            allowed = access if os.path.isdir(p) else access & FILE_ONLY
            rule = PathBeneath(allowed & fs, pfd)
            if libc.syscall(SYS_ADD_RULE, fd, RULE_PATH_BENEATH, ctypes.byref(rule), ctypes.c_uint32(0)) < 0:
                fail(f'landlock_add_rule {p} failed: {os.strerror(ctypes.get_errno())}')
            os.close(pfd)
    for port in ports:
        rule = NetPort(NET_CONNECT, int(port))
        if libc.syscall(SYS_ADD_RULE, fd, RULE_NET_PORT, ctypes.byref(rule), ctypes.c_uint32(0)) < 0:
            fail(f'landlock_add_rule port {port} failed: {os.strerror(ctypes.get_errno())}')
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        fail('prctl(NO_NEW_PRIVS) failed')
    if libc.syscall(SYS_RESTRICT, fd, ctypes.c_uint32(0)) < 0:
        fail(f'landlock_restrict_self failed: {os.strerror(ctypes.get_errno())}')
    os.close(fd)
    os.execvp(command[0], command)


if __name__ == '__main__':
    main(sys.argv[1:])
