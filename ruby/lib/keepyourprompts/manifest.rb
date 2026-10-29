# frozen_string_literal: true

require "json"

module KeepYourPrompts
  # envs/<app>/<env>.json: which body is live for each prompt. Unknown fields are ignored.
  Manifest = Struct.new(:workspace, :app, :env, :revision, :deployed_at, :prompts, keyword_init: true) do
    def self.parse(json, app: nil, env: nil)
      j = begin
        JSON.parse(json)
      rescue JSON::ParserError => e
        raise ProtocolError, "manifest is not valid JSON: #{e.message}"
      end
      raise ProtocolError, "manifest is not a JSON object" unless j.is_a?(Hash)
      if j.key?("schema") && j["schema"] != 1
        raise ProtocolError,
              "unsupported manifest schema (this SDK reads schema 1)"
      end

      workspace = str(j, "workspace", required: true)
      m_app = str(j, "app", required: true)
      m_env = str(j, "env", required: true)
      raise ProtocolError, "manifest workspace is not a valid slug" unless workspace_slug?(workspace)
      if (app && m_app != app) || (env && m_env != env)
        raise ProtocolError, "manifest is for #{m_app}/#{m_env}, expected #{app || m_app}/#{env || m_env}"
      end

      revision = j["revision"]
      unless revision.is_a?(Integer) && revision >= 0
        raise ProtocolError, %(manifest "revision" must be a non-negative integer)
      end

      new(workspace: workspace, app: m_app, env: m_env, revision: revision,
          deployed_at: str(j, "deployed_at", required: false), prompts: parse_prompts(j["prompts"])).freeze
    end

    def self.parse_prompts(raw)
      raise ProtocolError, %(manifest "prompts" must be an object) unless raw.is_a?(Hash)

      raw.keys.sort.to_h do |name|
        p = raw[name]
        if name.empty? || name.start_with?("/") || name.end_with?("/") || name.include?("//")
          raise ProtocolError, %(invalid prompt name "#{name}")
        end
        raise ProtocolError, %(prompt "#{name}" must be an object) unless p.is_a?(Hash)

        sha = p["sha256"]
        raise ProtocolError, %(prompt "#{name}" has no sha256) unless sha.is_a?(String)
        raise ProtocolError, %(prompt "#{name}" has an invalid sha256) unless sha256_hex?(sha = sha.downcase)

        version = p["version"].is_a?(Integer) ? p["version"] : 0
        vars = p["variables"].is_a?(Array) ? p["variables"].grep(String).freeze : [].freeze
        [name.freeze, { sha256: sha.freeze, version: version, variables: vars }.freeze]
      end.freeze
    end

    def self.str(json, key, required:)
      value = json[key]
      if value.nil?
        raise ProtocolError, %(manifest is missing "#{key}") if required

        return ""
      end
      raise ProtocolError, %(manifest "#{key}" must be a string) unless value.is_a?(String)

      value
    end

    def self.slug?(str) = str.is_a?(String) && str.match?(/\A[a-z0-9][a-z0-9-]{0,62}\z/)
    def self.sha256_hex?(str) = str.match?(/\A[0-9a-f]{64}\z/)
    def self.workspace_slug?(str) = str != "." && str != ".." && str.match?(/\A[A-Za-z0-9._-]{1,128}\z/)

    private_class_method :str, :parse_prompts
  end
end
