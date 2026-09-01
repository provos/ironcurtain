package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

const testProxyAuthorization = "Basic aXJvbmN1cnRhaW46QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ=="

func TestBoundedWriterNeverForwardsOverflowByte(t *testing.T) {
	var destination bytes.Buffer
	writer := &boundedWriter{destination: &destination, remaining: 1024}
	written, err := io.Copy(writer, bytes.NewReader(bytes.Repeat([]byte{'x'}, 2048)))
	if !errors.Is(err, errByteLimit) {
		t.Fatalf("expected byte-limit error, got %v", err)
	}
	if written != 1024 || destination.Len() != 1024 {
		t.Fatalf("byte limit was not exact: written=%d target=%d", written, destination.Len())
	}
}

func TestParseConfigAcceptsOnlyFixedIPv4Tuple(t *testing.T) {
	configuration, showVersion, err := parseConfig([]string{
		"--listen", "172.31.44.2:8443",
		"--target", "192.168.65.2:9443",
		"--allow-cidr", "172.31.44.0/24",
		"--max-concurrent", "8",
		"--max-bytes", "1048576",
		"--max-duration", "30s",
		"--dial-timeout", "1s",
		"--proxy-authorization", testProxyAuthorization,
	})
	if err != nil || showVersion {
		t.Fatalf("parseConfig failed: showVersion=%v err=%v", showVersion, err)
	}
	if configuration.targetAddress != "192.168.65.2:9443" || configuration.maxConcurrent != 8 {
		t.Fatalf("unexpected configuration: %#v", configuration)
	}
}

func TestParseConfigAcceptsOnlyFrozenDockerDesktopHostAlias(t *testing.T) {
	configuration, showVersion, err := parseConfig([]string{
		"--listen", "172.31.44.2:8443",
		"--target", "host.docker.internal:9443",
		"--allow-cidr", "172.31.44.0/24",
		"--proxy-authorization", testProxyAuthorization,
	})
	if err != nil || showVersion {
		t.Fatalf("parseConfig failed: showVersion=%v err=%v", showVersion, err)
	}
	if configuration.targetAddress != "host.docker.internal:9443" {
		t.Fatalf("unexpected fixed host-gateway target: %q", configuration.targetAddress)
	}
}

func TestParseConfigRejectsHostnameAndGenericOrInvalidAuthority(t *testing.T) {
	tests := [][]string{
		{"--listen", "172.31.44.2:8443", "--target", "example.test:9443", "--allow-cidr", "172.31.44.0/24"},
		{"--listen", "172.31.44.2:8443", "--target", "0.0.0.0:9443", "--allow-cidr", "172.31.44.0/24"},
		{"--listen", "0.0.0.0:8443", "--target", "192.168.65.2:9443", "--allow-cidr", "172.31.44.0/24"},
		{"--listen", "172.31.45.2:8443", "--target", "192.168.65.2:9443", "--allow-cidr", "172.31.44.0/24"},
		{"--listen", "172.31.44.2:8443", "--target", "192.168.65.2:9443", "--allow-cidr", "0.0.0.0/0"},
		{"--listen", "172.31.44.2:8443", "--target", "192.168.65.2:9443", "--allow-cidr", "172.31.44.0/24", "unexpected"},
	}
	for _, args := range tests {
		if _, _, err := parseConfig(args); err == nil {
			t.Fatalf("expected configuration rejection for %#v", args)
		}
	}
}

func TestParseConfigRequiresCanonicalProxyAuthorization(t *testing.T) {
	base := []string{
		"--listen", "172.31.44.2:8443",
		"--target", "192.168.65.2:9443",
		"--allow-cidr", "172.31.44.0/24",
	}
	for _, authorization := range []string{"", "Bearer secret", "Basic bm90LWlyb25jdXJ0YWlu"} {
		args := append(append([]string{}, base...), "--proxy-authorization", authorization)
		if _, _, err := parseConfig(args); err == nil {
			t.Fatalf("expected proxy authorization rejection for %q", authorization)
		}
	}
}

func TestSourceAllowedUsesOnlyFrozenCIDR(t *testing.T) {
	_, network, _ := net.ParseCIDR("172.31.44.0/24")
	r := relay{config: config{allowedCIDR: network}}
	if !r.sourceAllowed(&net.TCPAddr{IP: net.ParseIP("172.31.44.9"), Port: 1234}) {
		t.Fatal("expected source inside CIDR to pass")
	}
	if r.sourceAllowed(&net.TCPAddr{IP: net.ParseIP("172.31.45.9"), Port: 1234}) {
		t.Fatal("expected source outside CIDR to fail")
	}
}

func TestRelayForwardsBytesOnlyToConfiguredTarget(t *testing.T) {
	target, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		connection, acceptErr := target.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		var request strings.Builder
		for {
			line, readErr := reader.ReadString('\n')
			if readErr != nil {
				return
			}
			request.WriteString(line)
			if line == "\r\n" {
				break
			}
		}
		if !strings.Contains(request.String(), "Proxy-Authorization: "+testProxyAuthorization+"\r\n") {
			return
		}
		_, _ = io.WriteString(connection, "fixed-target")
	}()

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, allowed, _ := net.ParseCIDR("127.0.0.0/8")
	r := &relay{config: config{
		targetAddress:      target.Addr().String(),
		allowedCIDR:        allowed,
		maxConcurrent:      2,
		maxBytes:           1024,
		maxDuration:        5 * time.Second,
		dialTimeout:        time.Second,
		proxyAuthorization: testProxyAuthorization,
	}, sem: make(chan struct{}, 2)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- r.serve(ctx, listener) }()

	client, err := net.DialTimeout("tcp4", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Write([]byte("GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	response := make([]byte, len("fixed-target"))
	if _, err := io.ReadFull(client, response); err != nil {
		t.Fatal(err)
	}
	if string(response) != "fixed-target" {
		t.Fatalf("unexpected response: %q", response)
	}
	_ = client.Close()
	cancel()
	_ = listener.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("relay did not stop")
	}
}

func TestInjectProxyAuthorizationRejectsDownstreamCredentialWithoutForwarding(t *testing.T) {
	forwarded, err := injectTestRequest(
		"GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\nProxy-Authorization: Basic attacker\r\n\r\n",
	)
	if err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("expected downstream credential rejection, got %v", err)
	}
	if forwarded != "" {
		t.Fatalf("rejected request forwarded bytes: %q", forwarded)
	}
	if strings.Contains(err.Error(), testProxyAuthorization) {
		t.Fatal("rejection exposed the bundle credential")
	}
}

func TestInjectProxyAuthorizationRejectsOversizedOrMalformedHeadersWithoutForwarding(t *testing.T) {
	tests := map[string]string{
		"oversized":     "GET http://example.test/ HTTP/1.1\r\nX-Large: " + strings.Repeat("x", maxProxyHeaderBytes),
		"bare lf":       "GET http://example.test/ HTTP/1.1\nHost: example.test\n\n",
		"missing colon": "GET http://example.test/ HTTP/1.1\r\nMalformed\r\n\r\n",
		"folded header": "GET http://example.test/ HTTP/1.1\r\n Host: example.test\r\n\r\n",
		"invalid name":  "GET http://example.test/ HTTP/1.1\r\nBad Header: value\r\n\r\n",
		"bad request":   "GET  http://example.test/ HTTP/1.1\r\n\r\n",
	}
	for name, request := range tests {
		t.Run(name, func(t *testing.T) {
			forwarded, err := injectTestRequest(request)
			if err == nil {
				t.Fatal("expected malformed request rejection")
			}
			if forwarded != "" {
				t.Fatalf("rejected request forwarded bytes: %q", forwarded)
			}
			if strings.Contains(err.Error(), testProxyAuthorization) {
				t.Fatal("rejection exposed the bundle credential")
			}
		})
	}
}

func injectTestRequest(request string) (string, error) {
	server, client := net.Pipe()
	defer server.Close()
	done := make(chan struct{})
	go func() {
		_, _ = io.WriteString(client, request)
		_ = client.Close()
		close(done)
	}()
	var forwarded bytes.Buffer
	_, err := injectProxyAuthorization(server, &forwarded, testProxyAuthorization)
	_ = server.Close()
	<-done
	return forwarded.String(), err
}
