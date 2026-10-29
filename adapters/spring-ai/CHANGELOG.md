# Changelog

All notable changes to `com.keepyourprompts:kyp-spring-ai` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## 0.1.0 - 2026-10-29

First release (preview).

- `KypTemplateRenderer`: a Spring AI `TemplateRenderer` for `{{var}}` templates, rendered by the core SDK (strict by
  default).
- `KypPrompts`: `PromptTemplate`, `SystemPromptTemplate`, messages with `kyp.prompt.*` metadata and `Prompt`s from
  deployed prompts; `KypPromptMetadata`.
- Spring Boot auto-configuration with `kyp.*` properties and configuration metadata.
