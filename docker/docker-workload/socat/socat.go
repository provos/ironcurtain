// Command socat is a minimal, dependency-free byte forwarder used for
// bundle-internal socket bridging (for example a container-side UDS listener
// forwarded to a fixed TCP endpoint on the sidecar). It replaces a general
// `socat` dependency with a small, auditable binary that only ever bridges the
// two exact endpoints named on its argv.
//
// This binary is untrusted bundle-internal plumbing: unlike the trusted
// fixed-relay it makes no security claim. Both endpoints are fixed at startup;
// it performs no name resolution beyond dialing the exact target and selects no
// destination from connection data.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
)

const maxConcurrentConnections = 128

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "socat:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	fs := flag.NewFlagSet("socat", flag.ContinueOnError)
	listenSpec := fs.String("listen", "", "endpoint to accept on (unix:/path or tcp:host:port)")
	forwardSpec := fs.String("forward", "", "fixed endpoint to dial (unix:/path or tcp:host:port)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("positional arguments are forbidden")
	}
	listenNet, listenAddr, err := parseEndpoint(*listenSpec)
	if err != nil {
		return fmt.Errorf("invalid --listen: %w", err)
	}
	forwardNet, forwardAddr, err := parseEndpoint(*forwardSpec)
	if err != nil {
		return fmt.Errorf("invalid --forward: %w", err)
	}

	listener, err := net.Listen(listenNet, listenAddr)
	if err != nil {
		return err
	}
	defer listener.Close()

	slots := make(chan struct{}, maxConcurrentConnections)
	for {
		conn, err := listener.Accept()
		if err != nil {
			return err
		}
		slots <- struct{}{}
		go func() {
			defer func() { <-slots }()
			bridge(conn, forwardNet, forwardAddr)
		}()
	}
}

func bridge(client net.Conn, forwardNet, forwardAddr string) {
	defer client.Close()
	upstream, err := net.Dial(forwardNet, forwardAddr)
	if err != nil {
		return
	}
	defer upstream.Close()

	var wait sync.WaitGroup
	wait.Add(2)
	go copyOneWay(&wait, upstream, client)
	go copyOneWay(&wait, client, upstream)
	wait.Wait()
}

// copyOneWay pipes src into dst and then half-closes dst so the peer observes
// EOF, matching socat's shutdown-on-EOF behavior.
func copyOneWay(wait *sync.WaitGroup, dst, src net.Conn) {
	defer wait.Done()
	_, _ = io.Copy(dst, src)
	if half, ok := dst.(interface{ CloseWrite() error }); ok {
		_ = half.CloseWrite()
	}
}

func parseEndpoint(spec string) (network string, address string, err error) {
	if unixPath, ok := strings.CutPrefix(spec, "unix:"); ok {
		if unixPath == "" {
			return "", "", errors.New("unix endpoint requires a path")
		}
		return "unix", unixPath, nil
	}
	if tcpAddr, ok := strings.CutPrefix(spec, "tcp:"); ok {
		if _, _, splitErr := net.SplitHostPort(tcpAddr); splitErr != nil {
			return "", "", fmt.Errorf("tcp endpoint must be host:port: %w", splitErr)
		}
		return "tcp", tcpAddr, nil
	}
	return "", "", errors.New("endpoint must start with unix: or tcp:")
}
