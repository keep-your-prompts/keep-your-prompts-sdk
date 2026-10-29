// Command kyp is the Keep Your Prompts command-line tool.
//
//	go install github.com/keep-your-prompts/keep-your-prompts-sdk/cli/cmd/kyp@latest
package main

import (
	"context"
	"os"
	"os/signal"

	"github.com/keep-your-prompts/keep-your-prompts-sdk/cli/internal/app"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	code := app.New().Run(ctx, os.Args[1:])
	stop()
	os.Exit(code)
}
