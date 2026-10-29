import Foundation
#if canImport(os)
import os
#endif

/// A value guarded by `os_unfair_lock` on Apple platforms and `NSLock` elsewhere.
/// Critical sections are a few loads and stores; nothing blocks while holding it.
final class Locked<Value: Sendable>: @unchecked Sendable {
    #if canImport(os)
    private let lock: UnsafeMutablePointer<os_unfair_lock>
    #else
    private let lock = NSLock()
    #endif
    private var value: Value

    init(_ value: Value) {
        self.value = value
        #if canImport(os)
        lock = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
        lock.initialize(to: os_unfair_lock())
        #endif
    }

    deinit {
        #if canImport(os)
        lock.deinitialize(count: 1)
        lock.deallocate()
        #endif
    }

    @inline(__always)
    func withLock<R>(_ body: (inout Value) throws -> R) rethrows -> R {
        #if canImport(os)
        os_unfair_lock_lock(lock)
        defer { os_unfair_lock_unlock(lock) }
        #else
        lock.lock()
        defer { lock.unlock() }
        #endif
        return try body(&value)
    }

    @inline(__always)
    var current: Value { withLock { $0 } }
}

/// A FIFO async mutex: one refresh round at a time without blocking a thread.
final class AsyncMutex: Sendable {
    private struct State: Sendable {
        var locked = false
        var waiters: [CheckedContinuation<Void, Never>] = []
    }

    private let state = Locked(State())

    func lock() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let now = state.withLock { s -> Bool in
                if !s.locked {
                    s.locked = true
                    return true
                }
                s.waiters.append(c)
                return false
            }
            if now { c.resume() }
        }
    }

    func unlock() {
        let next = state.withLock { s -> CheckedContinuation<Void, Never>? in
            if s.waiters.isEmpty {
                s.locked = false
                return nil
            }
            return s.waiters.removeFirst()
        }
        next?.resume()
    }

    func run<R: Sendable>(_ body: @Sendable () async -> R) async -> R {
        await lock()
        let r = await body()
        unlock()
        return r
    }
}
