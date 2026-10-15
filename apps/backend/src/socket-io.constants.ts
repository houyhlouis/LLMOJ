// The judge and submission-progress gateways share one engine.io server on /api/socket, so they must
// agree on its options. The message limit applies before a connection is authenticated: it must fit
// the largest judge progress report (1000 test cases with display previews and compiler output) while
// staying far below the backend's heap size.
export const SOCKET_IO_MAX_MESSAGE_SIZE = 64 * 1024 * 1024;
