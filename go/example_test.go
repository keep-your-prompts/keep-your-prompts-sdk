package kyp_test

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	kyp "github.com/keep-your-prompts/keep-your-prompts-sdk/go"
)

func Example() {
	// In production: kyp.FromEnv(ctx) with KYP_DELIVERY_KEY, KYP_APP and KYP_ENV set.
	prompts, err := kyp.New(context.Background(), kyp.Options{
		App:         "demo",
		Env:         "prod",
		SnapshotDir: "../conformance/fixtures/v12", // a folder written by `kyp pull`
	})
	if err != nil {
		log.Fatal(err)
	}
	defer prompts.Close()

	text, err := prompts.Render("greeting", kyp.Vars{"name": "Ana", "company": "Acme"})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(text)
	// Output: Hello Ana, welcome to Acme.
}

func ExampleWithEmbeddedSnapshot() {
	// With a real binary:
	//
	//	//go:embed prompts
	//	var snapshot embed.FS
	snapshot := os.DirFS("../conformance/fixtures/v12")

	prompts, err := kyp.New(context.Background(), kyp.Options{App: "demo"}, kyp.WithEmbeddedSnapshot(snapshot))
	if err != nil {
		log.Fatal(err)
	}
	defer prompts.Close()
	st := prompts.Status()
	fmt.Println(st.Source, st.Revision)
	// Output: embedded 12
}

func ExampleClient_OnUpdate() {
	prompts, err := kyp.New(context.Background(), kyp.Options{App: "demo", SnapshotDir: "../conformance/fixtures/v12"})
	if err != nil {
		log.Fatal(err)
	}
	defer prompts.Close()
	unregister := prompts.OnUpdate(func(u kyp.Update) {
		log.Printf("prompts: revision %d -> %d from %s, changed %v", u.OldRevision, u.NewRevision, u.Source, u.Changed)
	})
	defer unregister()
}

func ExampleClient_Status() {
	prompts, err := kyp.New(context.Background(), kyp.Options{App: "demo", SnapshotDir: "../conformance/fixtures/v12"})
	if err != nil {
		log.Fatal(err)
	}
	defer prompts.Close()
	if st := prompts.Status(); st.StaleFor > 10*time.Minute && !st.LastSuccess.IsZero() {
		log.Printf("prompts are %s old: %s", st.StaleFor, st.LastError)
	}
	fmt.Println(prompts.Revision(), prompts.Names())
	// Output: 12 [agents/reviewer empty greeting triage]
}

func ExampleRenderTemplate() {
	out, _ := kyp.RenderTemplate("Hi {{ name }}, use {{{{name}} for variables.", kyp.Vars{"name": "Ana"})
	fmt.Println(out)

	_, err := kyp.RenderTemplate("{{a}} {{b}}", kyp.Vars{"a": "1"})
	var missing *kyp.MissingVariableError
	fmt.Println(errors.As(err, &missing), missing.Names)

	lenient, _ := kyp.RenderTemplate("{{a}} {{b}}", kyp.Vars{"a": "1"}, kyp.MissingKeep)
	fmt.Println(lenient)
	// Output:
	// Hi Ana, use {{name}} for variables.
	// true [b]
	// 1 {{b}}
}

func ExampleTemplateVariables() {
	fmt.Println(kyp.TemplateVariables("Hi {{name}} from {{ company }} ({{name}})"))
	// Output: [name company]
}

func ExampleClient_RecordOutcome() {
	prompts, err := kyp.New(context.Background(), kyp.Options{
		App: "demo", SnapshotDir: "../conformance/fixtures/v12",
		APIKey: os.Getenv("KYP_API_KEY"), // batches are sent in the background and on Close
	})
	if err != nil {
		log.Fatal(err)
	}
	defer prompts.Close()
	start := time.Now()
	// ... call the model with the rendered prompt ...
	err = prompts.RecordOutcome(kyp.Outcome{Prompt: "greeting", Result: kyp.OutcomeSuccess, Latency: time.Since(start)})
	if errors.Is(err, kyp.ErrOutcomesDisabled) {
		return // no KYP_API_KEY: reporting is off
	}
}
