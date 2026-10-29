package com.keepyourprompts;

import java.util.List;

/**
 * Passed to update listeners after a new revision was swapped in.
 *
 * @param oldRevision revision held before, 0 if nothing was loaded
 * @param newRevision revision now served
 * @param source mirror that delivered it, e.g. {@code cdn}
 * @param changed prompts added, removed or with a new body
 */
public record Update(long oldRevision, long newRevision, String source, List<String> changed) {
  public Update {
    changed = List.copyOf(changed);
  }
}
