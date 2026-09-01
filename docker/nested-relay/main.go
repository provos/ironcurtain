// ironcurtain-fixed-relay is a single-destination proxy relay for DD-PROXY.
// It injects one host-hop credential but has no protocol for choosing a destination.
package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const version = "ironcurtain-fixed-relay-v1"
const dockerDesktopHostGatewayAlias = "host.docker.internal"
const maxProxyHeaderBytes = 64 * 1024

var errByteLimit = errors.New("relay byte limit reached")

type config struct {
	listenAddress      string
	targetAddress      string
	allowedCIDR        *net.IPNet
	maxConcurrent      int
	maxBytes           int64
	maxDuration        time.Duration
	dialTimeout        time.Duration
	proxyAuthorization string
}

type relay struct {
	config config
	sem    chan struct{}
	nextID atomic.Uint64
}

type boundedWriter struct {
	destination io.Writer
	remaining   int64
}

func (w *boundedWriter) Write(contents []byte) (int, error) {
	if w.remaining <= 0 {
		return 0, errByteLimit
	}
	if int64(len(contents)) > w.remaining {
		contents = contents[:w.remaining]
		written, err := w.destination.Write(contents)
		w.remaining -= int64(written)
		if err != nil {
			return written, err
		}
		return written, errByteLimit
	}
	written, err := w.destination.Write(contents)
	w.remaining -= int64(written)
	return written, err
}

func main() {
	configuration, showVersion, err := parseConfig(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "configuration error: %v\n", err)
		os.Exit(2)
	}
	if showVersion {
		fmt.Println(version)
		return
	}

	listener, err := net.Listen("tcp4", configuration.listenAddress)
	if err != nil {
		log.Fatalf("listen failed: %v", err)
	}
	server := &relay{config: configuration, sem: make(chan struct{}, configuration.maxConcurrent)}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()

	log.Printf("relay ready version=%s listen=%s source=%s", version, listener.Addr(), configuration.allowedCIDR)
	if err := server.serve(ctx, listener); err != nil && !errors.Is(err, net.ErrClosed) {
		log.Fatalf("relay failed: %v", err)
	}
}

func parseConfig(args []string) (config, bool, error) {
	flags := flag.NewFlagSet("ironcurtain-fixed-relay", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	listenAddress := flags.String("listen", "", "exact IPv4 listen address")
	targetAddress := flags.String("target", "", "exact IPv4 target address or frozen Docker Desktop host-gateway alias")
	allowCIDR := flags.String("allow-cidr", "", "only admitted IPv4 source CIDR")
	maxConcurrent := flags.Int("max-concurrent", 64, "maximum concurrent streams")
	maxBytes := flags.Int64("max-bytes", 256*1024*1024, "maximum bytes in each direction")
	maxDuration := flags.Duration("max-duration", 10*time.Minute, "maximum stream lifetime")
	dialTimeout := flags.Duration("dial-timeout", 5*time.Second, "fixed-target dial timeout")
	proxyAuthorization := flags.String("proxy-authorization", "", "fixed Proxy-Authorization header injected upstream")
	showVersion := flags.Bool("version", false, "print version")
	if err := flags.Parse(args); err != nil {
		return config{}, false, err
	}
	if flags.NArg() != 0 {
		return config{}, false, errors.New("positional arguments are forbidden")
	}
	if *showVersion {
		if len(args) != 1 {
			return config{}, false, errors.New("--version cannot be combined with relay configuration")
		}
		return config{}, true, nil
	}

	listen, err := validateIPv4Endpoint(*listenAddress, false)
	if err != nil {
		return config{}, false, fmt.Errorf("listen: %w", err)
	}
	target, err := validateTargetEndpoint(*targetAddress)
	if err != nil {
		return config{}, false, fmt.Errorf("target: %w", err)
	}
	allowedIP, network, err := net.ParseCIDR(*allowCIDR)
	if err != nil || network.IP.To4() == nil {
		return config{}, false, errors.New("allow-cidr must be one explicit IPv4 CIDR")
	}
	prefix, bits := network.Mask.Size()
	if bits != 32 || prefix < 16 || prefix > 30 || !allowedIP.Equal(network.IP) || !network.IP.IsPrivate() {
		return config{}, false, errors.New("allow-cidr must be a canonical private IPv4 /16-/30 network")
	}
	listenIP, _, _ := net.SplitHostPort(listen)
	if !network.Contains(net.ParseIP(listenIP)) {
		return config{}, false, errors.New("listen address must be inside allow-cidr")
	}
	if *maxConcurrent < 1 || *maxConcurrent > 4096 {
		return config{}, false, errors.New("max-concurrent must be between 1 and 4096")
	}
	if *maxBytes < 1024 || *maxBytes > 16*1024*1024*1024 {
		return config{}, false, errors.New("max-bytes must be between 1 KiB and 16 GiB")
	}
	if *maxDuration < time.Second || *maxDuration > 24*time.Hour {
		return config{}, false, errors.New("max-duration must be between 1s and 24h")
	}
	if *dialTimeout < 100*time.Millisecond || *dialTimeout > time.Minute {
		return config{}, false, errors.New("dial-timeout must be between 100ms and 1m")
	}
	if err := validateProxyAuthorization(*proxyAuthorization); err != nil {
		return config{}, false, err
	}
	return config{
		listenAddress:      listen,
		targetAddress:      target,
		allowedCIDR:        network,
		maxConcurrent:      *maxConcurrent,
		maxBytes:           *maxBytes,
		maxDuration:        *maxDuration,
		dialTimeout:        *dialTimeout,
		proxyAuthorization: *proxyAuthorization,
	}, false, nil
}

func validateProxyAuthorization(value string) error {
	if !strings.HasPrefix(value, "Basic ") {
		return errors.New("proxy-authorization must be one Basic credential")
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, "Basic "))
	if err != nil || !strings.HasPrefix(string(decoded), "ironcurtain:") || len(decoded) != len("ironcurtain:")+43 {
		return errors.New("proxy-authorization must be one canonical IronCurtain bundle credential")
	}
	for _, character := range string(decoded[len("ironcurtain:"):]) {
		if !(character >= 'a' && character <= 'z') && !(character >= 'A' && character <= 'Z') &&
			!(character >= '0' && character <= '9') && character != '_' && character != '-' {
			return errors.New("proxy-authorization contains an invalid bundle token")
		}
	}
	return nil
}

func validateTargetEndpoint(value string) (string, error) {
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		return "", errors.New("must be host:port")
	}
	if host == dockerDesktopHostGatewayAlias {
		port, portErr := strconv.Atoi(portText)
		if portErr != nil || port < 1 || port > 65535 {
			return "", errors.New("port must be between 1 and 65535")
		}
		return net.JoinHostPort(host, strconv.Itoa(port)), nil
	}
	return validateIPv4Endpoint(value, false)
}

func validateIPv4Endpoint(value string, allowUnspecified bool) (string, error) {
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		return "", errors.New("must be IP:port")
	}
	ip := net.ParseIP(host)
	if ip == nil || ip.To4() == nil {
		return "", errors.New("hostnames and non-IPv4 addresses are forbidden")
	}
	if !allowUnspecified && ip.IsUnspecified() {
		return "", errors.New("target cannot be unspecified")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return "", errors.New("port must be between 1 and 65535")
	}
	return net.JoinHostPort(ip.String(), strconv.Itoa(port)), nil
}

func (r *relay) serve(ctx context.Context, listener net.Listener) error {
	var handlers sync.WaitGroup
	defer handlers.Wait()
	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if !r.sourceAllowed(connection.RemoteAddr()) {
			log.Printf("connection rejected remote=%s", connection.RemoteAddr())
			_ = connection.Close()
			continue
		}
		select {
		case r.sem <- struct{}{}:
			handlers.Add(1)
			go func() {
				defer handlers.Done()
				defer func() { <-r.sem }()
				r.handle(ctx, connection)
			}()
		default:
			log.Printf("connection rejected reason=capacity remote=%s", connection.RemoteAddr())
			_ = connection.Close()
		}
	}
}

func (r *relay) sourceAllowed(address net.Addr) bool {
	tcpAddress, ok := address.(*net.TCPAddr)
	return ok && tcpAddress.IP.To4() != nil && r.config.allowedCIDR.Contains(tcpAddress.IP)
}

func (r *relay) handle(ctx context.Context, downstream net.Conn) {
	id := r.nextID.Add(1)
	defer downstream.Close()
	dialer := net.Dialer{Timeout: r.config.dialTimeout}
	upstream, err := dialer.DialContext(ctx, "tcp4", r.config.targetAddress)
	if err != nil {
		log.Printf("stream=%d target-connect=failed", id)
		return
	}
	defer upstream.Close()
	closed := make(chan struct{})
	defer close(closed)
	go func() {
		select {
		case <-ctx.Done():
			_ = downstream.Close()
			_ = upstream.Close()
		case <-closed:
		}
	}()
	deadline := time.Now().Add(r.config.maxDuration)
	_ = downstream.SetDeadline(deadline)
	_ = upstream.SetDeadline(deadline)
	authorizedDownstream, err := injectProxyAuthorization(downstream, upstream, r.config.proxyAuthorization)
	if err != nil {
		log.Printf("stream=%d proxy-authorization=failed", id)
		return
	}

	type copyResult struct {
		direction string
		bytes     int64
		exceeded  bool
		err       error
	}
	results := make(chan copyResult, 2)
	copyBounded := func(direction string, destination io.Writer, source io.Reader) {
		bytes, copyErr := io.Copy(&boundedWriter{destination: destination, remaining: r.config.maxBytes}, source)
		results <- copyResult{
			direction: direction,
			bytes:     bytes,
			exceeded:  errors.Is(copyErr, errByteLimit),
			err:       copyErr,
		}
	}
	go copyBounded("up", upstream, authorizedDownstream)
	go copyBounded("down", downstream, upstream)
	first := <-results
	_ = downstream.Close()
	_ = upstream.Close()
	second := <-results
	log.Printf(
		"stream=%d closed %s_bytes=%d %s_bytes=%d limit=%t error=%t",
		id,
		first.direction,
		first.bytes,
		second.direction,
		second.bytes,
		first.exceeded || second.exceeded,
		first.err != nil || second.err != nil,
	)
}

func injectProxyAuthorization(downstream net.Conn, upstream io.Writer, authorization string) (io.Reader, error) {
	reader := bufio.NewReaderSize(downstream, maxProxyHeaderBytes)
	var header strings.Builder
	firstLine := true
	for header.Len() <= maxProxyHeaderBytes {
		lineBytes, err := reader.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			return nil, errors.New("proxy request header exceeds limit")
		}
		if err != nil {
			return nil, err
		}
		line := string(lineBytes)
		if !strings.HasSuffix(line, "\r\n") {
			return nil, errors.New("proxy request header requires CRLF framing")
		}
		if firstLine {
			firstLine = false
			requestLine := strings.TrimSuffix(line, "\r\n")
			parts := strings.Split(requestLine, " ")
			if len(parts) != 3 || !validHTTPToken(parts[0]) || parts[1] == "" || (parts[2] != "HTTP/1.1" && parts[2] != "HTTP/1.0") {
				return nil, errors.New("downstream did not send one HTTP proxy request")
			}
		} else if line != "\r\n" {
			field := strings.TrimSuffix(line, "\r\n")
			separator := strings.IndexByte(field, ':')
			if separator <= 0 || !validHTTPToken(field[:separator]) || !validHTTPFieldValue(field[separator+1:]) {
				return nil, errors.New("downstream sent a malformed HTTP proxy header")
			}
			if strings.EqualFold(field[:separator], "Proxy-Authorization") {
				return nil, errors.New("downstream proxy authorization is forbidden")
			}
		}
		header.WriteString(line)
		if header.Len() > maxProxyHeaderBytes {
			return nil, errors.New("proxy request header exceeds limit")
		}
		if line == "\r\n" {
			request := header.String()
			injected := strings.TrimSuffix(request, "\r\n") + "Proxy-Authorization: " + authorization + "\r\n\r\n"
			if _, err := io.WriteString(upstream, injected); err != nil {
				return nil, err
			}
			return reader, nil
		}
	}
	return nil, errors.New("proxy request header exceeds limit")
}

func validHTTPToken(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range []byte(value) {
		if !(character >= '0' && character <= '9') &&
			!(character >= 'A' && character <= 'Z') &&
			!(character >= 'a' && character <= 'z') &&
			!strings.ContainsRune("!#$%&'*+-.^_`|~", rune(character)) {
			return false
		}
	}
	return true
}

func validHTTPFieldValue(value string) bool {
	for _, character := range []byte(value) {
		if (character < 0x20 && character != '\t') || character == 0x7f {
			return false
		}
	}
	return true
}
