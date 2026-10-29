# frozen_string_literal: true

module KeepYourPrompts
  # Process._fork (Ruby 3.1+) is called by every fork variant (Kernel#fork, Process.fork,
  # IO.popen("-"), Puma/Unicorn workers). Threads do not survive a fork, so restart the
  # pollers in the child and drop the parent's sockets.
  module ForkHook
    def _fork
      pid = super
      KeepYourPrompts::Client.after_fork! if pid.zero?
      pid
    end
  end
end

Process.singleton_class.prepend(KeepYourPrompts::ForkHook) if Process.respond_to?(:_fork)
