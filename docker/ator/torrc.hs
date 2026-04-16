# torrc template — Hidden Service + Client + Relay role
# Variables substituted by entrypoint.sh via envsubst:
#   ${NICKNAME} ${ORPORT} ${DIRPORT} ${CONTROL_PORT} ${SOCKS_PORT} ${HIDDEN_SERVICE_PORT}
#   ${DIRAUTH1_LINE} ${DIRAUTH2_LINE} ${DIRAUTH3_LINE}
Nickname ${NICKNAME}
DataDirectory /var/lib/anon
ContactInfo test-hs@local
Log notice stdout
RunAsDaemon 0

TestingTorNetwork 1
AssumeReachable 1
ProtocolWarnings 1

# Ports
ORPort ${ORPORT}
DirPort ${DIRPORT}
# ControlPort bound to localhost only — defense-in-depth (see torrc.dirauth).
ControlPort 127.0.0.1:${CONTROL_PORT}
CookieAuthentication 1

# Client SOCKS5 listener — this is the only host-reachable port in the ator profile.
# Bound to 0.0.0.0 inside the container; docker-compose publishes it to 127.0.0.1 on host.
SOCKSPort 0.0.0.0:${SOCKS_PORT} IsolateClientProtocol

# Also act as a relay so hs1 contributes circuits
ExitRelay 0
ExitPolicy reject *:*
BandwidthRate 100 MBytes
BandwidthBurst 200 MBytes

# Hidden service — points to an in-container echo server placeholder on
# 127.0.0.1:${HIDDEN_SERVICE_PORT}. Stories 36.3 / 36.4 dial in from the
# host via the SOCKS port.
HiddenServiceDir /var/lib/anon/hs
HiddenServicePort ${HIDDEN_SERVICE_PORT} 127.0.0.1:${HIDDEN_SERVICE_PORT}

${DIRAUTH1_LINE}
${DIRAUTH2_LINE}
${DIRAUTH3_LINE}
