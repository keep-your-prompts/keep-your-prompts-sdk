import Foundation

/// What `render` does with a `{{variable}}` that has no value.
public enum OnMissing: Sendable {
    /// Throw ``KYPError/missingVariables(_:)`` listing every missing name (default).
    case error
    /// Leave `{{name}}` in the output exactly as written.
    case keep
    /// Replace it with the empty string.
    case empty
}

private enum Piece {
    case literal(Range<Int>)
    case braces
    case variable(name: Range<Int>, raw: Range<Int>)
}

@inline(__always) private func identStart(_ c: UInt8) -> Bool {
    (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) || c == 0x5F
}
@inline(__always) private func identChar(_ c: UInt8) -> Bool { identStart(c) || (c >= 0x30 && c <= 0x39) }
@inline(__always) private func isSpace(_ c: UInt8) -> Bool { c == 0x20 || c == 0x09 }

private let open: UInt8 = 0x7B  // {
private let close: UInt8 = 0x7D  // }

/// At `t[i]`, `t[i+1]` == `{{`: parses `{{ name }}`.
private func parseVar(_ t: UnsafeBufferPointer<UInt8>, _ i: Int) -> (Range<Int>, Int)? {
    var j = i + 2
    while j < t.count && isSpace(t[j]) { j += 1 }
    guard j < t.count, identStart(t[j]) else { return nil }
    let start = j
    while j < t.count && identChar(t[j]) { j += 1 }
    let nameEnd = j
    while j < t.count && isSpace(t[j]) { j += 1 }
    guard j + 1 < t.count, t[j] == close, t[j + 1] == close else { return nil }
    return (start..<nameEnd, j + 2)
}

private func scan(_ t: UnsafeBufferPointer<UInt8>, _ f: (Piece) -> Void) {
    var i = 0
    var run = 0
    let n = t.count
    while i + 1 < n {
        guard t[i] == open, t[i + 1] == open else {
            i += 1
            continue
        }
        if i + 3 < n, t[i + 2] == open, t[i + 3] == open {
            f(.literal(run..<i))
            f(.braces)
            i += 4
            run = i
            continue
        }
        if let (name, end) = parseVar(t, i) {
            f(.literal(run..<i))
            f(.variable(name: name, raw: i..<end))
            i = end
            run = end
        } else {
            i += 2  // not a variable: keep the braces as text
        }
    }
    f(.literal(run..<n))
}

private func withBytes<R>(_ s: String, _ body: (UnsafeBufferPointer<UInt8>) throws -> R) rethrows -> R {
    if let r = try s.utf8.withContiguousStorageIfAvailable(body) { return r }
    return try Array(s.utf8).withUnsafeBufferPointer(body)
}

/// Renders `template`: each `{{name}}` is replaced by its value; `{{{{` renders a literal `{{`.
/// Values are inserted verbatim and never rendered again.
public func renderTemplate(_ template: String, _ vars: [String: String], onMissing: OnMissing = .error) throws -> String {
    var missing: [String] = []
    let out: [UInt8] = withBytes(template) { t in
        var out: [UInt8] = []
        out.reserveCapacity(t.count + 64)
        scan(t) { piece in
            switch piece {
            case .literal(let r):
                out.append(contentsOf: UnsafeBufferPointer(rebasing: t[r]))
            case .braces:
                out.append(open)
                out.append(open)
            case .variable(let name, let raw):
                let key = String(decoding: UnsafeBufferPointer(rebasing: t[name]), as: UTF8.self)
                if let v = vars[key] {
                    out.append(contentsOf: v.utf8)
                } else {
                    switch onMissing {
                    case .keep: out.append(contentsOf: UnsafeBufferPointer(rebasing: t[raw]))
                    case .empty: break
                    case .error: if !missing.contains(key) { missing.append(key) }
                    }
                }
            }
        }
        return out
    }
    if !missing.isEmpty { throw KYPError.missingVariables(missing) }
    return String(decoding: out, as: UTF8.self)
}

/// Distinct variable names in order of first appearance.
public func templateVariables(in template: String) -> [String] {
    withBytes(template) { t in
        var names: [String] = []
        scan(t) { piece in
            if case .variable(let name, _) = piece {
                let key = String(decoding: UnsafeBufferPointer(rebasing: t[name]), as: UTF8.self)
                if !names.contains(key) { names.append(key) }
            }
        }
        return names
    }
}
