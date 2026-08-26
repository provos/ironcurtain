package main

import (
	"fmt"
	"os"
	"syscall"
)

const realRunc = "/usr/local/bin/runc"

func main() {
	args := append([]string{"runc"}, os.Args[1:]...)
	for index, argument := range args {
		if argument != "create" && argument != "run" {
			continue
		}
		if !contains(args[index+1:], "--no-new-keyring") {
			args = append(args[:index+1], append([]string{"--no-new-keyring"}, args[index+1:]...)...)
		}
		break
	}
	if err := syscall.Exec(realRunc, args, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "ironcurtain runc shim: %v\n", err)
		os.Exit(127)
	}
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
