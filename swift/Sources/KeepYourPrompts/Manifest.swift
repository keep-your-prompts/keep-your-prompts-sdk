import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Lowercase hex SHA-256 of `data` (CryptoKit on Apple platforms, swift-crypto elsewhere).
public func sha256Hex(_ data: Data) -> String {
    let digest = SHA256.hash(data: data)
    let hex: [UInt8] = Array("0123456789abcdef".utf8)
    var out = [UInt8]()
    out.reserveCapacity(64)
    for b in digest {
        out.append(hex[Int(b >> 4)])
        out.append(hex[Int(b & 15)])
    }
    return String(decoding: out, as: UTF8.self)
}

/// One entry of a manifest's `prompts` object.
public struct ManifestPrompt: Sendable, Equatable {
    public var sha256: String
    public var version: Int
    public var variables: [String]
}

/// A parsed, validated manifest (`envs/<app>/<env>.json`).
public struct Manifest: Sendable, Equatable {
    public var workspace: String
    public var app: String
    public var env: String
    public var revision: Int
    public var deployedAt: String
    /// Prompts by name.
    public var prompts: [String: ManifestPrompt]
    /// Prompt names, sorted.
    public var names: [String] { prompts.keys.sorted() }

    /// Parses and validates a manifest for `app`/`env`. Unknown fields are ignored.
    public static func parse(_ data: Data, app: String, env: String) throws -> Manifest {
        func bad(_ m: String) -> KYPError { .protocolError(m) }
        let raw: RawManifest
        do {
            raw = try JSONDecoder().decode(RawManifest.self, from: data)
        } catch let e as KYPError {
            throw e
        } catch {
            throw bad("manifest is not a valid JSON object with the expected field types")
        }
        if let s = raw.schema, s != 1 { throw bad("unsupported manifest schema (this SDK reads schema 1)") }
        guard let workspace = raw.workspace else { throw bad("manifest is missing \"workspace\"") }
        guard let mApp = raw.app else { throw bad("manifest is missing \"app\"") }
        guard let mEnv = raw.env else { throw bad("manifest is missing \"env\"") }
        guard isWorkspaceSlug(workspace) else { throw bad("manifest workspace is not a valid slug") }
        guard mApp == app, mEnv == env else { throw bad("manifest is for \(mApp)/\(mEnv), expected \(app)/\(env)") }
        guard let revision = raw.revision, revision >= 0 else {
            throw bad("manifest \"revision\" must be a non-negative integer")
        }
        guard let rawPrompts = raw.prompts else { throw bad("manifest \"prompts\" must be an object") }
        var prompts: [String: ManifestPrompt] = [:]
        for (name, p) in rawPrompts {
            if name.isEmpty || name.hasPrefix("/") || name.hasSuffix("/") || name.contains("//") {
                throw bad("invalid prompt name \"\(name)\"")
            }
            guard let sha = p.sha256?.lowercased() else { throw bad("prompt \"\(name)\" has no sha256") }
            guard isSHA256Hex(sha) else { throw bad("prompt \"\(name)\" has an invalid sha256") }
            prompts[name] = ManifestPrompt(sha256: sha, version: p.version ?? 0, variables: p.variables)
        }
        return Manifest(workspace: workspace, app: mApp, env: mEnv, revision: revision,
                        deployedAt: raw.deployedAt ?? "", prompts: prompts)
    }
}

private struct RawPrompt: Decodable {
    var sha256: String?
    var version: Int?
    var variables: [String]

    enum CodingKeys: String, CodingKey { case sha256, version, variables }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sha256 = try? c.decodeIfPresent(String.self, forKey: .sha256)
        version = try? c.decodeIfPresent(Int.self, forKey: .version)
        variables = (try? c.decodeIfPresent([String].self, forKey: .variables)) ?? []
    }
}

private struct RawManifest: Decodable {
    var schema: Int?
    var workspace: String?
    var app: String?
    var env: String?
    var revision: Int?
    var deployedAt: String?
    var prompts: [String: RawPrompt]?

    enum CodingKeys: String, CodingKey {
        case schema, workspace, app, env, revision, prompts
        case deployedAt = "deployed_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if c.contains(.schema), !(try c.decodeNil(forKey: .schema)) {
            guard let s = try? c.decode(Int.self, forKey: .schema) else {
                throw KYPError.protocolError("unsupported manifest schema (this SDK reads schema 1)")
            }
            schema = s
        }
        workspace = try c.decodeIfPresent(String.self, forKey: .workspace)
        app = try c.decodeIfPresent(String.self, forKey: .app)
        env = try c.decodeIfPresent(String.self, forKey: .env)
        revision = try? c.decodeIfPresent(Int.self, forKey: .revision)
        deployedAt = try c.decodeIfPresent(String.self, forKey: .deployedAt)
        prompts = try? c.decodeIfPresent([String: RawPrompt].self, forKey: .prompts)
    }
}

/// `[a-z0-9][a-z0-9-]{0,62}`.
func isSlug(_ s: String) -> Bool {
    let b = Array(s.utf8)
    guard !b.isEmpty, b.count <= 63 else { return false }
    for (i, c) in b.enumerated() {
        let ok = (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || (i > 0 && c == 0x2D)
        if !ok { return false }
    }
    return true
}

func isWorkspaceSlug(_ s: String) -> Bool {
    guard !s.isEmpty, s.utf8.count <= 128, s != ".", s != ".." else { return false }
    return s.utf8.allSatisfy { c in
        (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) || (c >= 0x30 && c <= 0x39) || c == 0x2D || c == 0x5F
            || c == 0x2E
    }
}

func isSHA256Hex(_ s: String) -> Bool {
    s.utf8.count == 64 && s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
}
