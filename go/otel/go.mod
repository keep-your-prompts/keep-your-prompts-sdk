module github.com/keep-your-prompts/keep-your-prompts-sdk/go/otel

go 1.23.0

require (
	github.com/keep-your-prompts/keep-your-prompts-sdk/go v0.1.0
	go.opentelemetry.io/otel v1.38.0
	go.opentelemetry.io/otel/metric v1.38.0
	go.opentelemetry.io/otel/sdk v1.38.0
	go.opentelemetry.io/otel/sdk/metric v1.38.0
	go.opentelemetry.io/otel/trace v1.38.0
)

require (
	github.com/go-logr/logr v1.4.4 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/google/uuid v1.6.0 // indirect
	go.opentelemetry.io/auto/sdk v1.2.0 // indirect
	golang.org/x/sys v0.35.0 // indirect
)

// Developed in step with the SDK in the parent folder. Replace directives are
// ignored by modules that depend on this one.
replace github.com/keep-your-prompts/keep-your-prompts-sdk/go => ../
