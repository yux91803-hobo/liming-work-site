/* liming-tcp-keepalive: runner-only LD_PRELOAD shim.
 * Why: the box VM is periodically paused by its host; on resume the host-side
 * egress proxy (198.18.0.1) silently black-holes pre-pause TCP flows (no RST).
 * .NET then waits its full 100 s HTTP timeout on a dead pooled connection.
 * This shim enables TCP keepalive + TCP_USER_TIMEOUT on outbound TCP sockets
 * of Runner.Listener / Runner.Worker only, so dead flows fail in ~30 s and the
 * runner's own retry opens a fresh connection. Never reads/changes payloads. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int enabled = -1;
static int (*real_connect)(int, const struct sockaddr *, socklen_t);

static int env_int(const char *name, int def) {
    const char *v = getenv(name);
    if (!v || !*v) return def;
    int x = atoi(v);
    return x > 0 ? x : def;
}

static int is_enabled(void) {
    if (enabled >= 0) return enabled;
    enabled = 0;
    if (getenv("LIMING_TCP_SHIM_FORCE")) { enabled = 1; return enabled; }
    char exe[512];
    ssize_t n = readlink("/proc/self/exe", exe, sizeof(exe) - 1);
    if (n > 0) {
        exe[n] = 0;
        const char *b = strrchr(exe, '/');
        b = b ? b + 1 : exe;
        if (!strcmp(b, "Runner.Listener") || !strcmp(b, "Runner.Worker")) enabled = 1;
    }
    return enabled;
}

int connect(int fd, const struct sockaddr *addr, socklen_t len) {
    if (!real_connect) real_connect = dlsym(RTLD_NEXT, "connect");
    if (addr && (addr->sa_family == AF_INET || addr->sa_family == AF_INET6) && is_enabled()) {
        int type = 0; socklen_t tl = sizeof(type);
        if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &tl) == 0 && type == SOCK_STREAM) {
            int saved = errno, one = 1;
            int idle = env_int("LIMING_TCP_KEEPIDLE", 15);
            int intvl = env_int("LIMING_TCP_KEEPINTVL", 5);
            int cnt = env_int("LIMING_TCP_KEEPCNT", 3);
            unsigned int uto = (unsigned int)env_int("LIMING_TCP_USER_TIMEOUT_MS", 30000);
            setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one));
            setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle));
            setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof(intvl));
            setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &cnt, sizeof(cnt));
            setsockopt(fd, IPPROTO_TCP, TCP_USER_TIMEOUT, &uto, sizeof(uto));
            errno = saved;
        }
    }
    return real_connect(fd, addr, len);
}
