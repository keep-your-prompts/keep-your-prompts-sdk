#!/bin/sh
# Install kyp from the GitHub release (linux and macOS, amd64 and arm64).
#
#   curl -fsSL https://raw.githubusercontent.com/keep-your-prompts/keep-your-prompts-sdk/main/cli/scripts/install.sh | sh
#
# PLACEHOLDER: the short URL https://keepyourprompts.com/install.sh is not live
# yet. Environment: KYP_VERSION (default: latest cli-v* release), KYP_INSTALL_DIR
# (default: /usr/local/bin if writable, else ~/.local/bin).
set -eu

repo="keep-your-prompts/keep-your-prompts-sdk"
version="${KYP_VERSION:-}"
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$repo/releases?per_page=50" |
    sed -n 's/.*"tag_name": *"cli-v\([^"]*\)".*/\1/p' | head -n 1)
fi
[ -n "$version" ] || { echo "install.sh: no kyp release found" >&2; exit 1; }

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in linux|darwin) ;; *) echo "install.sh: unsupported OS $os (on Windows download the .zip from the release page)" >&2; exit 1 ;; esac
arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "install.sh: unsupported CPU $arch" >&2; exit 1 ;; esac

name="kyp_${version}_${os}_${arch}"
base="https://github.com/$repo/releases/download/cli-v$version"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$name.tar.gz" "$base/$name.tar.gz"
curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"
expected=$(grep " $name.tar.gz\$" "$tmp/checksums.txt" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$name.tar.gz" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$tmp/$name.tar.gz" | cut -d' ' -f1)
fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "install.sh: checksum mismatch for $name.tar.gz" >&2; exit 1; }
tar -C "$tmp" -xzf "$tmp/$name.tar.gz"

dir="${KYP_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -w /usr/local/bin ]; then dir=/usr/local/bin; else dir="$HOME/.local/bin"; fi
fi
mkdir -p "$dir"
install -m 0755 "$tmp/$name/kyp" "$dir/kyp"
echo "Installed kyp $version to $dir/kyp"
case ":$PATH:" in *":$dir:"*) ;; *) echo "Add $dir to your PATH." ;; esac
