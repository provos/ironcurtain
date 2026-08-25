#!/bin/sh
set -eu

test "$HTTP_PROXY" = "http://127.0.0.1:18082"
test "$HTTPS_PROXY" = "http://127.0.0.1:18082"
test "$http_proxy" = "http://127.0.0.1:18082"
test "$https_proxy" = "http://127.0.0.1:18082"
test "$NODE_EXTRA_CA_CERTS" = "/dev/ironcurtain/ca-cert.pem"
test "$SSL_CERT_FILE" = "/dev/ironcurtain/ca-bundle.pem"
test "$CURL_CA_BUNDLE" = "/dev/ironcurtain/ca-bundle.pem"
test "$GIT_SSL_CAINFO" = "/dev/ironcurtain/ca-bundle.pem"
test "$npm_config_cafile" = "/dev/ironcurtain/ca-bundle.pem"
test "$PIP_CERT" = "/dev/ironcurtain/ca-bundle.pem"
test "$REQUESTS_CA_BUNDLE" = "/dev/ironcurtain/ca-bundle.pem"
test "$CARGO_HTTP_CAINFO" = "/dev/ironcurtain/ca-bundle.pem"
test "$APT_CONFIG" = "/dev/ironcurtain/apt.conf"
test "$npm_config_audit" = "false"
test "$PIP_DISABLE_PIP_VERSION_CHECK" = "1"
test "$UV_NATIVE_TLS" = "1"
test -r /dev/ironcurtain/ca-cert.pem
test -r /dev/ironcurtain/ca-bundle.pem
test -r /dev/ironcurtain/apt.conf
test ! -w /dev/ironcurtain/ca-cert.pem
test ! -w /dev/ironcurtain/ca-bundle.pem
test ! -w /dev/ironcurtain/apt.conf
test ! -e /dev/ironcurtain/ca-key.pem
