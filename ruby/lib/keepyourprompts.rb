# frozen_string_literal: true

require_relative "keepyourprompts/version"
require_relative "keepyourprompts/errors"
require_relative "keepyourprompts/template"
require_relative "keepyourprompts/prompt"
require_relative "keepyourprompts/manifest"
require_relative "keepyourprompts/status"
require_relative "keepyourprompts/config"
require_relative "keepyourprompts/http"
require_relative "keepyourprompts/client"
require_relative "keepyourprompts/fork_hook"

# Keep Your Prompts: deployed prompts read from memory, kept fresh in the background.
#
#   require "keepyourprompts"
#   KeepYourPrompts.client.render("triage", company: "Acme")
module KeepYourPrompts
  @lock = Mutex.new
  @options = {}
  @client = nil

  class << self
    # Options for the shared client (merged over the KYP_* environment). Resets it.
    def configure(**options)
      old = @lock.synchronize do
        @options = options
        c = @client
        @client = nil
        c
      end
      old&.close
      self
    end

    # The process-wide client, built on first use from configure + ENV.
    def client
      @client || @lock.synchronize { @client ||= Client.from_env(**@options) }
    end

    def get(name) = client.get(name)
    def render(name, vars = nil, **kwargs) = client.render(name, vars, **kwargs)
    def prompt(name) = client.prompt(name)
    def status = client.status
  end
end

require_relative "keepyourprompts/railtie" if defined?(Rails::Railtie)
