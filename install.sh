#!/bin/sh
# Timmy installer — fetches the prebuilt single binary, verifies its checksum, installs it.
#
#   curl -fsSL <install-url> | sh
#
# No Node, no toolchain, no build step — just download + verify + place on PATH.
#
# Overridable for local testing / pinning:
#   TIMMY_INSTALL_BASE_URL   where to fetch <asset> + SHA256SUMS from (default: the latest GitHub release)
#   TIMMY_BIN_DIR            install destination (default: ~/.local/bin)
#   TIMMY_VERSION            a specific tag instead of "latest" (e.g. v0.1.0-beta.0)
set -eu

REPO="omatsetyadi/timmy"
BIN_DIR="${TIMMY_BIN_DIR:-$HOME/.local/bin}"

err() { printf 'error: %s\n' "$1" >&2; exit 1; }
info() { printf '%s\n' "$1" >&2; }

# ── platform → asset name (must match the CI release asset names) ──
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os_tag="darwin" ;;
  Linux)  os_tag="linux" ;;
  *) err "unsupported OS: $os (macOS and Linux only)" ;;
esac
case "$arch" in
  arm64|aarch64) arch_tag="arm64" ;;
  x86_64|amd64)  arch_tag="x64" ;;
  *) err "unsupported architecture: $arch" ;;
esac
asset="timmy-${os_tag}-${arch_tag}"

# ── source URL ──
if [ -n "${TIMMY_INSTALL_BASE_URL:-}" ]; then
  base_url="$TIMMY_INSTALL_BASE_URL"
elif [ -n "${TIMMY_VERSION:-}" ]; then
  base_url="https://github.com/${REPO}/releases/download/${TIMMY_VERSION}"
else
  base_url="https://github.com/${REPO}/releases/latest/download"
fi

# ── checksum tool (shasum on macOS, sha256sum on Linux) ──
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  err "need sha256sum or shasum to verify the download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

info "Downloading ${asset} from ${base_url} ..."
curl -fsSL "${base_url}/${asset}" -o "${tmp}/timmy" || err "download failed: ${base_url}/${asset}"
curl -fsSL "${base_url}/SHA256SUMS" -o "${tmp}/SHA256SUMS" || err "could not fetch SHA256SUMS"

# ── verify: the computed hash must match the line for this asset in SHA256SUMS ──
expected="$(awk -v a="$asset" '$2 == a || $2 == "*"a {print $1}' "${tmp}/SHA256SUMS" | head -n1)"
[ -n "$expected" ] || err "no checksum for ${asset} in SHA256SUMS"
actual="$(sha256 "${tmp}/timmy")"
[ "$expected" = "$actual" ] || err "checksum mismatch for ${asset} (expected ${expected}, got ${actual})"
info "Checksum verified."

# ── install ──
mkdir -p "$BIN_DIR"
mv "${tmp}/timmy" "${BIN_DIR}/timmy"
chmod +x "${BIN_DIR}/timmy"
info "Installed timmy → ${BIN_DIR}/timmy"

# ── PATH advice ──
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) info ""
     info "NOTE: ${BIN_DIR} is not on your PATH. Add this to your shell profile:"
     info "  export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac

info ""
info "Done. Next: run 'timmy init' to set up, then 'timmy start'."
