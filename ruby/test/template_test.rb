# frozen_string_literal: true

require "test_helper"

class TemplateTest < Minitest::Test
  T = KeepYourPrompts::Template

  def test_missing_variables_listed_once
    err = assert_raises(KeepYourPrompts::MissingVariable) { T.render("{{a}} {{b}} {{a}}", {}) }
    assert_equal %w[a b], err.names
    assert_equal "missing template variables: a, b", err.message
  end

  def test_modes_and_value_types
    assert_equal "[] [x]", T.render("[{{a}}] [{{b}}]", { b: "x" }, on_missing: :empty)
    assert_equal "1 2.5 true", T.render("{{i}} {{f}} {{t}}", { "i" => 1, f: 2.5, t: true })
    assert_equal "{{a}}", T.render("{{a}}", { a: nil }, on_missing: :keep)
  end

  def test_edge_cases_match_other_sdks
    assert_equal "{{{x}}", T.render("{{{x}}", { x: "y" })
    assert_equal "{{", T.render("{{", {})
    assert_equal "a}}b", T.render("a}}b", {})
    assert_equal "v\tv", T.render("{{\tx\t}}\t{{x}}", { x: "v" })
    assert_equal ["x"], T.variables("{{ x }}{{x}}{{{{y}}")
    assert_equal Encoding::UTF_8, T.render("é {{n}}", { n: "日本" }).encoding
  end

  def test_prompt_render
    p = KeepYourPrompts::Prompt.new(name: "p", version: 1, sha256: "0" * 64, variables: ["who"], text: "Hi {{who}}")

    assert_equal "Hi Ana", p.render(who: "Ana")
    assert_equal "Hi {{who}}", p.render(on_missing: :keep)
    assert_equal "Hi {{who}}", p.to_s
  end
end
