# frozen_string_literal: true

module KeepYourPrompts
  # A deployed prompt: immutable, content-addressed by its sha256.
  Prompt = Struct.new(:name, :version, :sha256, :variables, :text, keyword_init: true) do
    def render(on_missing: :error, **vars)
      Template.render(text, vars, on_missing: on_missing)
    end

    def to_s
      text
    end
  end
end
