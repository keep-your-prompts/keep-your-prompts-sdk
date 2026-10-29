#!/usr/bin/env bash
# Cross-compile kyp for linux, darwin and windows on amd64 and arm64 and write
# release archives plus checksums.txt to cli/dist/.
#
#   cli/scripts/build.sh            # version from internal/app/app.go
#   cli/scripts/build.sh 0.1.0      # must match it
set -euo pipefail

cd "$(dirname "$0")/.."
src_version=$(sed -n 's/^const Version = "\(.*\)"$/\1/p' internal/app/app.go)
version=${1:-$src_version}
version=${version#cli-v}
version=${version#v}
if [[ "$version" != "$src_version" ]]; then
  echo "build.sh: version $version does not match internal/app/app.go ($src_version)" >&2
  exit 1
fi
commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)

rm -rf dist
mkdir -p dist
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do
  goos=${target%/*}
  goarch=${target#*/}
  name="kyp_${version}_${goos}_${goarch}"
  exe=kyp
  [[ "$goos" == windows ]] && exe=kyp.exe
  mkdir -p "dist/$name"
  echo "building $name"
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath \
    -ldflags "-s -w -X github.com/keep-your-prompts/keep-your-prompts-sdk/cli/internal/app.commit=$commit" \
    -o "dist/$name/$exe" ./cmd/kyp
  cp README.md CHANGELOG.md "dist/$name/"
  cp ../LICENSE "dist/$name/"
  if [[ "$goos" == windows ]]; then
    (cd dist && zip -qr "$name.zip" "$name")
  else
    tar -C dist -czf "dist/$name.tar.gz" "$name"
  fi
  rm -rf "dist/$name"
done

cd dist
if command -v sha256sum >/dev/null; then
  sha256sum kyp_* > checksums.txt
else
  shasum -a 256 kyp_* > checksums.txt
fi
cat checksums.txt
