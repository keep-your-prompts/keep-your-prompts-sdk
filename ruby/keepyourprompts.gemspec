# frozen_string_literal: true

require_relative "lib/keepyourprompts/version"

Gem::Specification.new do |spec|
  spec.name = "keepyourprompts"
  spec.version = KeepYourPrompts::VERSION
  spec.authors = ["Keep Your Prompts"]
  spec.summary = "Keep Your Prompts SDK: deployed prompts read from memory, kept fresh in the background."
  spec.description = <<~DESC
    Reads prompts deployed with Keep Your Prompts from memory (no I/O, no locks), revalidates them in a
    background thread across interchangeable mirrors (bundled snapshot, disk cache, CDN, origin, git) with
    ETags, verifies every body with SHA-256, and keeps serving the last good version when the network does not.
    Fork-safe for Puma and Unicorn; includes a tiny Rails railtie. No runtime dependencies.
  DESC
  spec.license = "LicenseRef-Republic-Lex-Aequa-1.0"
  spec.homepage = "https://github.com/keep-your-prompts/keep-your-prompts-sdk/tree/main/ruby"
  spec.required_ruby_version = ">= 3.1"
  spec.metadata = {
    "homepage_uri" => spec.homepage,
    "source_code_uri" => "https://github.com/keep-your-prompts/keep-your-prompts-sdk/tree/main/ruby",
    "changelog_uri" => "https://github.com/keep-your-prompts/keep-your-prompts-sdk/blob/main/ruby/CHANGELOG.md",
    "bug_tracker_uri" => "https://github.com/keep-your-prompts/keep-your-prompts-sdk/issues",
    "rubygems_mfa_required" => "true"
  }
  # LICENSE is copied from the repository root by the release workflow.
  spec.files = Dir["lib/**/*.rb", "README.md", "CHANGELOG.md", "LICENSE"]
  spec.require_paths = ["lib"]
end
