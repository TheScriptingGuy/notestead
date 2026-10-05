#!/bin/sh
# Entrypoint of the Notestead `web` image (ADR-0002 §Configuration, ADR-0006). It checks the environment, derives
# JOPLIN_SERVER_HOST's default from JOPLIN_SERVER_PUBLIC_URL, then runs Caddy on /etc/caddy/Caddyfile, which reads
# these variables as {$VAR}. Caddy substitutes them before parsing, so a value must not carry Caddyfile syntax.
set -eu

fail() {
	printf 'notestead-web: %s\n' "$1" >&2
	exit 64
}

# Refuses whitespace, braces, quotes, backslashes and '#': they would change the Caddyfile's tokens.
plain() {
	case $2 in
		*[[:space:]{}\"\'\`\\#]*) fail "$1 must not contain whitespace, braces, quotes, backslashes or '#'" ;;
	esac
}

http_url() {
	case $2 in
		http://?* | https://?*) ;;
		*) fail "$1 must be an http:// or https:// URL" ;;
	esac
	plain "$1" "$2"
}

# The host[:port] that upstream's isValidOrigin compares: WHATWG URL.host (lower case, no default port).
url_host() {
	rest=${1#*://}
	authority=$(printf '%s' "${rest%%/*}" | tr 'A-Z' 'a-z')
	case $1 in
		[Hh][Tt][Tt][Pp][Ss]://*) authority=${authority%:443} ;;
		*) authority=${authority%:80} ;;
	esac
	printf '%s' "$authority"
}

JOPLIN_SERVER_URL=${JOPLIN_SERVER_URL:-}
JOPLIN_SERVER_PUBLIC_URL=${JOPLIN_SERVER_PUBLIC_URL:-}
[ -n "$JOPLIN_SERVER_URL" ] || fail 'JOPLIN_SERVER_URL is required: the direct address of your Joplin Server, e.g. http://192.168.1.10:22300'
[ -n "$JOPLIN_SERVER_PUBLIC_URL" ] || fail "JOPLIN_SERVER_PUBLIC_URL is required: your Joplin Server's APP_BASE_URL"
http_url JOPLIN_SERVER_URL "$JOPLIN_SERVER_URL"
case ${JOPLIN_SERVER_URL#*://} in
	*[@?#]* | */?*) fail 'JOPLIN_SERVER_URL must be scheme://host[:port], without credentials, path or query' ;;
esac
http_url JOPLIN_SERVER_PUBLIC_URL "$JOPLIN_SERVER_PUBLIC_URL"
case ${JOPLIN_SERVER_PUBLIC_URL#*://} in
	*[@?#]*) fail 'JOPLIN_SERVER_PUBLIC_URL must not contain credentials, a query or a fragment' ;;
esac
while :; do
	case $JOPLIN_SERVER_PUBLIC_URL in
		*/) JOPLIN_SERVER_PUBLIC_URL=${JOPLIN_SERVER_PUBLIC_URL%/} ;;
		*) break ;;
	esac
done

JOPLIN_SERVER_HOST=${JOPLIN_SERVER_HOST:-$(url_host "$JOPLIN_SERVER_PUBLIC_URL")}
case $JOPLIN_SERVER_HOST in
	'' | *[!]A-Za-z0-9.:[-]*) fail "JOPLIN_SERVER_HOST must be a host[:port] (got '$JOPLIN_SERVER_HOST')" ;;
esac

COEP=${COEP:-credentialless}
case $COEP in
	credentialless | require-corp) ;;
	*) fail "COEP must be credentialless or require-corp (got '$COEP')" ;;
esac

TRUSTED_PROXIES=${TRUSTED_PROXIES:-}
CLIENT_IP_HEADER=${CLIENT_IP_HEADER:-}
case $TRUSTED_PROXIES in
	*[!0-9A-Za-z.:/_\ ]*) fail 'TRUSTED_PROXIES must be IP addresses or CIDR ranges separated by spaces' ;;
esac
case $CLIENT_IP_HEADER in
	*[!A-Za-z0-9-]*) fail 'CLIENT_IP_HEADER must be a single header name, e.g. CF-Connecting-IP' ;;
esac
if [ -n "$CLIENT_IP_HEADER" ] && [ -z "$TRUSTED_PROXIES" ]; then
	fail 'CLIENT_IP_HEADER is only read from TRUSTED_PROXIES; set both or neither'
fi

export JOPLIN_SERVER_URL JOPLIN_SERVER_PUBLIC_URL JOPLIN_SERVER_HOST COEP TRUSTED_PROXIES CLIENT_IP_HEADER
printf 'notestead-web: /joplin-server/api/* -> %s with Host %s; COEP %s; trusted proxies: %s\n' \
	"$JOPLIN_SERVER_URL" "$JOPLIN_SERVER_HOST" "$COEP" "${TRUSTED_PROXIES:-none}" >&2
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
