# frozen_string_literal: true

module KeepYourPrompts
  # Base class of everything the SDK raises.
  class Error < StandardError; end

  # get/prompt/render for a name that is not in the deployed manifest.
  class NotFound < Error
    attr_reader :name

    def initialize(name, detail = nil)
      @name = name
      super(%(prompt not found: "#{name}"#{" (#{detail})" if detail}))
    end
  end

  # No mirror could deliver a manifest during start-up (see Config#startup_timeout).
  class Unavailable < Error; end

  # A mirror returned something that does not follow the delivery protocol.
  class ProtocolError < Error; end

  # render was called without a value for one or more {{variables}}.
  class MissingVariable < Error
    attr_reader :names

    def initialize(names)
      @names = names.freeze
      super("missing template variable#{"s" if names.size > 1}: #{names.join(", ")}")
    end
  end
end
