# frozen_string_literal: true

require "test_helper"

class ManifestTest < Minitest::Test
  BASE = { "schema" => 1, "workspace" => "acme", "app" => "demo", "env" => "prod", "revision" => 1,
           "prompts" => {} }.freeze
  SHA = "a" * 64

  def parse(obj)
    KeepYourPrompts::Manifest.parse(obj.is_a?(String) ? obj : JSON.generate(obj), app: "demo", env: "prod")
  end

  def test_rejects_invalid
    [
      "{", "[1]", BASE.merge("app" => "other"), BASE.merge("env" => "dev"), BASE.merge("revision" => -1),
      BASE.merge("revision" => "3"), BASE.merge("prompts" => [{ "sha256" => SHA }]),
      BASE.merge("prompts" => { "/x" => { "sha256" => SHA } }),
      BASE.merge("prompts" => { "a//b" => { "sha256" => SHA } }),
      BASE.merge("prompts" => { "p" => { "version" => 1 } }),
      BASE.merge("workspace" => "../x"), BASE.except("workspace")
    ].each do |bad|
      assert_raises(KeepYourPrompts::ProtocolError, bad.inspect) { parse(bad) }
    end
  end

  def test_normalises_and_sorts
    m = parse(BASE.except("schema").merge("revision" => 0, "prompts" => {
                                            "b/c" => { "sha256" => "A" * 64, "variables" => ["x", 3] },
                                            "a" => { "sha256" => SHA }
                                          }))

    assert_equal %w[a b/c], m.prompts.keys
    assert_equal "a" * 64, m.prompts["b/c"][:sha256]
    assert_equal ["x"], m.prompts["b/c"][:variables]
    assert_equal 0, m.prompts["a"][:version]
    assert_equal "", m.deployed_at
    assert_predicate m, :frozen?
  end

  def test_slugs
    assert KeepYourPrompts::Manifest.slug?("support-bot")
    refute KeepYourPrompts::Manifest.slug?("-x")
    refute KeepYourPrompts::Manifest.slug?("Upper")
    refute KeepYourPrompts::Manifest.slug?("a" * 64)
    refute KeepYourPrompts::Manifest.slug?("a\n")
  end
end
