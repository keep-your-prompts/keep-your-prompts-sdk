# frozen_string_literal: true

require "strscan"

module KeepYourPrompts
  # {{name}} templates: optional spaces inside the braces, names [A-Za-z_][A-Za-z0-9_]*,
  # "{{{{" renders a literal "{{". No logic, loops or escaping; values are not rendered again.
  module Template
    OPEN = /\{\{/
    VAR = /[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\}\}/

    module_function

    # on_missing: :error (raise MissingVariable, default), :keep (leave {{name}}), :empty.
    def render(template, vars = {}, on_missing: :error)
      out = +""
      missing = []
      scan(template) do |kind, text, raw|
        if kind == :lit
          out << text
        elsif (value = lookup(vars, text)).nil?
          case on_missing
          when :keep then out << raw
          when :empty then nil
          else missing << text unless missing.include?(text)
          end
        else
          out << value.to_s
        end
      end
      raise MissingVariable, missing unless missing.empty?

      out
    end

    # Distinct variable names in order of first appearance.
    def variables(template)
      names = []
      scan(template) { |kind, text| names << text if kind == :var && !names.include?(text) }
      names
    end

    # Yields [:lit, text] and [:var, name, raw] in order.
    def scan(template)
      ss = StringScanner.new(template)
      lit = +""
      until ss.eos?
        chunk = ss.scan_until(OPEN)
        unless chunk
          lit << ss.rest
          break
        end
        lit << chunk.byteslice(0, chunk.bytesize - 2)
        # "{{{{" is an escaped "{{"; "{{" not starting a variable stays as text.
        raw = ss.scan(OPEN) ? nil : ss.scan(VAR)
        if raw
          yield :lit, lit unless lit.empty?
          lit = +""
          yield :var, ss[1], "{{#{raw}"
        else
          lit << "{{"
        end
      end
      yield :lit, lit unless lit.empty?
    end

    def lookup(vars, name)
      return nil if vars.nil?

      vars.fetch(name.to_sym) { vars[name] }
    end
    private_class_method :lookup
  end
end
