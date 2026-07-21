// Command helper is a minimal, dependency-free bundle utility used by the
// trusted nested-runtime bootstrap for bounded, offline setup steps: proving a
// bind-mounted path is present, writing a readiness marker, waiting for a
// late-created socket/file to appear, or idling for a liveness probe.
//
// It performs no network I/O and takes no host input beyond its argv. All
// operations are bounded so it can never hang a bootstrap step.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"time"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "helper:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	fs := flag.NewFlagSet("helper", flag.ContinueOnError)
	touch := fs.String("touch", "", "create an empty marker file at this path and exit")
	waitFor := fs.String("wait-for", "", "poll until this path exists, then exit")
	sleep := fs.Duration("sleep", 0, "idle for this bounded duration, then exit")
	timeout := fs.Duration("timeout", 30*time.Second, "bound for --wait-for polling")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("positional arguments are forbidden")
	}
	if *timeout <= 0 || *timeout > 10*time.Minute {
		return errors.New("timeout must be within (0, 10m]")
	}

	switch {
	case *touch != "":
		file, err := os.OpenFile(*touch, os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		return file.Close()
	case *waitFor != "":
		return waitForPath(*waitFor, *timeout)
	default:
		if *sleep < 0 || *sleep > 10*time.Minute {
			return errors.New("sleep must be within [0, 10m]")
		}
		time.Sleep(*sleep)
		return nil
	}
}

func waitForPath(path string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if _, err := os.Stat(path); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("path %q did not appear within %s", path, timeout)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
