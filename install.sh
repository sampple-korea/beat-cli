#!/bin/sh
# User-local BeAT installer. Compatible with macOS /bin/sh and Linux POSIX sh.
set -eu
umask 077

say() { printf '%s\n' "$*" >&2; }
die() { say "beat install: $*"; exit 1; }
usage() {
  cat <<'HELP'
Usage: sh install.sh [--with-deps] [--no-setup] [--no-path] [--force]

Installs BeAT in the current user's directory. Never overwrites ordinary codex.
  --with-deps  Allow system Node.js packages on Alpine (may use sudo).
  --no-setup   Install BeAT only; defer Codex download until beat setup.
  --no-path    Do not append PATH setup to shell profiles.
  --force      Explicitly replace an existing, non-BeAT command at BEAT_BIN_DIR/beat.
  --help       Show this help without downloads or filesystem changes.

Environment:
  BEAT_DATA_HOME      Application/runtime directory (default: XDG_DATA_HOME/beat-cli).
  BEAT_BIN_DIR        Command directory (default: ~/.local/bin).
  BEAT_REF            Repository ref to download (default: main; a commit is safest).
  BEAT_SOURCE_DIR     Install an already-downloaded local checkout instead of fetching.
  BEAT_ARCHIVE_SHA256 Optional expected SHA-256 of the downloaded repository archive.
  BEAT_NODE_VERSION   Exact Node.js 22+ version; otherwise bootstrap latest Node.js 22.
  BEAT_INSTALL_FORCE_NODE=1  Bootstrap a private Node even if Node is already installed.
HELP
}
SETUP=1
WITH_DEPS=0
ADD_PATH=1
FORCE=0
for option in "$@"; do
  case "$option" in
    --with-deps) WITH_DEPS=1 ;;
    --no-setup) SETUP=0 ;;
    --no-path) ADD_PATH=0 ;;
    --force) FORCE=1 ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $option. Use --help." ;;
  esac
done
: "${HOME:?HOME must name the current user home directory}"
DATA=${BEAT_DATA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/beat-cli}
BIN=${BEAT_BIN_DIR:-$HOME/.local/bin}
REF=${BEAT_REF:-main}
case "$DATA" in /*) ;; *) die 'BEAT_DATA_HOME must be an absolute path.' ;; esac
case "$BIN" in /*) ;; *) die 'BEAT_BIN_DIR must be an absolute path.' ;; esac
case "$DATA$BIN" in *'
'*) die 'Newlines in installation paths are not supported.' ;; esac
case "$REF" in ''|-*|*[!a-zA-Z0-9._/-]*) die 'BEAT_REF must be a branch, tag, or commit identifier.' ;; esac
case "$(uname -s)" in Darwin) SYSTEM=darwin ;; Linux) SYSTEM=linux ;; *) die 'Use this installer on macOS or Linux. On Windows, install Node.js 22+ and use npm install -g github:sampple-korea/beat-cli.' ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) die 'The official Codex binary supports x64 and arm64 only; this CPU is unsupported.' ;; esac
for program in tar awk sed grep mktemp; do command -v "$program" >/dev/null 2>&1 || die "Required utility not found: $program"; done

# The quote function is used for generated shell files, never eval.
quote() { printf "'"; printf '%s' "$1" | sed "s/'/'\\\\''/g"; printf "'"; }
fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error --retry 3 --connect-timeout 20 --max-time 600 --proto '=https' --proto-redir '=https' "$1" --output "$2" || die "Download failed: $1"
  elif command -v wget >/dev/null 2>&1; then
    case "$1" in https://*) ;; *) die 'Only HTTPS downloads are allowed.' ;; esac
    wget -q --timeout=30 --tries=3 -O "$2" "$1" || die "Download failed: $1"
  else
    die 'Install curl or wget (with CA certificates) and run the installer again.'
  fi
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}';
  else die 'SHA-256 verification requires sha256sum, shasum, or openssl.'; fi
}
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@";
  elif command -v sudo >/dev/null 2>&1; then sudo "$@";
  else die 'System dependencies need administrator access. Install them separately, then rerun without --with-deps.'; fi
}

mkdir -p "$DATA" "$BIN" "$DATA/app/releases"
DATA=$(cd "$DATA" && pwd -P)
BIN=$(cd "$BIN" && pwd -P)
if [ -e "$BIN/beat" ] || [ -L "$BIN/beat" ]; then
  if ! grep -q '^# beat-cli-managed-launcher-v1$' "$BIN/beat" 2>/dev/null && [ "$FORCE" != 1 ]; then
    die "$BIN/beat already exists and is not managed by this installer. Choose BEAT_BIN_DIR, or explicitly pass --force."
  fi
fi
LOCK=$DATA/.installer-lock
if ! mkdir "$LOCK" 2>/dev/null; then
  die "Another installer may be running. Lock: $LOCK. If an earlier installer was killed, remove only this lock directory after confirming it is no longer running."
fi
printf '%s\n' "$$" > "$LOCK/pid"
SCRATCH=
STAGING=
SHIM=
cleanup() {
  code=$?
  trap - EXIT HUP INT TERM
  [ -z "$SHIM" ] || rm -f "$SHIM"
  [ -z "$STAGING" ] || rm -rf "$STAGING"
  [ -z "$SCRATCH" ] || rm -rf "$SCRATCH"
  rm -f "$LOCK/pid"
  rmdir "$LOCK" 2>/dev/null || :
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
SCRATCH=$(mktemp -d "$DATA/.bootstrap.XXXXXX")

NODE=
if [ "${BEAT_INSTALL_FORCE_NODE:-0}" != 1 ] && command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  if node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
    NODE=$(node -p 'process.execPath')
  fi
fi
if [ -z "$NODE" ] && [ "$SYSTEM" = linux ] && [ -f /etc/alpine-release ]; then
  if [ "$WITH_DEPS" = 1 ]; then
    say 'Installing Alpine Node.js/npm using the system package manager (--with-deps)...'
    as_root apk add nodejs npm
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die 'This Alpine release needs a repository with Node.js 22 or newer.'
    NODE=$(node -p 'process.execPath')
  else
    die 'Alpine uses musl: first install Node.js 22+ and npm with apk, or rerun with --with-deps. A glibc Node binary will not be installed on Alpine.'
  fi
fi
if [ -z "$NODE" ]; then
  VERSION=${BEAT_NODE_VERSION:-}
  if [ -n "$VERSION" ]; then
    VERSION=${VERSION#v}
    printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die 'BEAT_NODE_VERSION must be an exact stable version, e.g. 22.23.2.'
    [ "${VERSION%%.*}" -ge 22 ] || die 'Node.js 22 or newer is required.'
    NODE_URL=https://nodejs.org/dist/v$VERSION
  else
    NODE_URL=https://nodejs.org/dist/latest-v22.x
  fi
  say "Preparing a private Node.js runtime for $SYSTEM/$ARCH..."
  fetch "$NODE_URL/SHASUMS256.txt" "$SCRATCH/SHASUMS256.txt"
  NODE_FILE=$(awk -v suffix="-$SYSTEM-$ARCH.tar.gz" '$2 ~ /^node-v[0-9]+\.[0-9]+\.[0-9]+-/ && substr($2, length($2)-length(suffix)+1) == suffix {print $2}' "$SCRATCH/SHASUMS256.txt")
  [ -n "$NODE_FILE" ] || die 'The official Node release has no matching binary.'
  case "$NODE_FILE" in *' '*|*'
'*|*/*|*..*) die 'Unexpected Node archive name in the checksum manifest.' ;; esac
  EXPECTED=$(awk -v file="$NODE_FILE" '$2 == file {print $1}' "$SCRATCH/SHASUMS256.txt")
  printf '%s\n' "$EXPECTED" | grep -Eq '^[a-fA-F0-9]{64}$' || die 'Invalid Node SHA-256 manifest entry.'
  NODE_TAG=${NODE_FILE%.tar.gz}
  NODE_PREFIX=$DATA/node/$NODE_TAG
  if [ ! -x "$NODE_PREFIX/bin/node" ]; then
    fetch "$NODE_URL/$NODE_FILE" "$SCRATCH/$NODE_FILE"
    [ "$(sha256 "$SCRATCH/$NODE_FILE")" = "$EXPECTED" ] || die 'Node archive SHA-256 mismatch; nothing will be installed.'
    mkdir -p "$SCRATCH/node" "$DATA/node"
    tar -xzf "$SCRATCH/$NODE_FILE" -C "$SCRATCH/node" --strip-components=1
    "$SCRATCH/node/bin/node" --version || die 'The official Node binary cannot run here. Check libc/OS support or install Node.js 22+ through your distribution.'
    mv "$SCRATCH/node" "$NODE_PREFIX"
  fi
  NODE=$NODE_PREFIX/bin/node
fi
NODE_DIR=$(dirname "$NODE")
PATH=$NODE_DIR:$PATH
export PATH
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die 'Node.js 22+ failed its startup check.'
command -v npm >/dev/null 2>&1 || die 'npm is missing from this Node installation.'
say "Node: $("$NODE" --version)"

STAGING=$(mktemp -d "$DATA/app/releases/.install.XXXXXX")
if [ -n "${BEAT_SOURCE_DIR:-}" ]; then
  [ -f "$BEAT_SOURCE_DIR/beat.js" ] && [ -f "$BEAT_SOURCE_DIR/package-lock.json" ] || die 'BEAT_SOURCE_DIR must contain beat.js and package-lock.json.'
  tar -C "$BEAT_SOURCE_DIR" --exclude=.git --exclude=node_modules --exclude=.test-data --exclude=.config --exclude='.env*' --exclude='*.log' --exclude=session.json --exclude=credentials.json --exclude=service.json --exclude=state.json -cf "$SCRATCH/source.tar" .
  tar -xf "$SCRATCH/source.tar" -C "$STAGING"
else
  say "Downloading sampple-korea/beat-cli ($REF)..."
  fetch "https://codeload.github.com/sampple-korea/beat-cli/tar.gz/$REF" "$SCRATCH/beat.tar.gz"
  if [ -n "${BEAT_ARCHIVE_SHA256:-}" ]; then
    printf '%s\n' "$BEAT_ARCHIVE_SHA256" | grep -Eq '^[a-f0-9]{64}$' || die 'BEAT_ARCHIVE_SHA256 must contain 64 lowercase hexadecimal characters.'
    [ "$(sha256 "$SCRATCH/beat.tar.gz")" = "$BEAT_ARCHIVE_SHA256" ] || die 'BeAT archive SHA-256 mismatch.'
  fi
  tar -xzf "$SCRATCH/beat.tar.gz" -C "$STAGING" --strip-components=1
fi
[ -f "$STAGING/beat.js" ] && [ -f "$STAGING/package-lock.json" ] || die 'The downloaded ref is not a compatible BeAT release.'
say 'Installing locked BeAT dependencies in an isolated release directory...'
(cd "$STAGING" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
"$NODE" --check "$STAGING/beat.js"
"$NODE" "$STAGING/beat.js" help >/dev/null
BEAT_DATA_HOME=$DATA
export BEAT_DATA_HOME
if [ "$SETUP" = 1 ]; then
  if [ "$WITH_DEPS" = 1 ]; then "$NODE" "$STAGING/beat.js" setup --with-deps;
  else "$NODE" "$STAGING/beat.js" setup; fi
fi

RELEASE=$DATA/app/releases/release-$(date +%Y%m%d%H%M%S)-$$
[ ! -e "$RELEASE" ] || die 'Release directory collision; rerun the installer.'
mv "$STAGING" "$RELEASE"
STAGING=
SHIM=$(mktemp "$BIN/.beat.XXXXXX")
{
  printf '%s\n' '#!/bin/sh' '# beat-cli-managed-launcher-v1'
  printf 'if [ -z "${BEAT_DATA_HOME:-}" ]; then BEAT_DATA_HOME='; quote "$DATA"; printf '; export BEAT_DATA_HOME; fi\n'
  printf 'BEAT_LAUNCHER_PATH='; quote "$BIN/beat"; printf '; export BEAT_LAUNCHER_PATH\n'
  printf 'PATH='; quote "$NODE_DIR"; printf ':"$PATH"; export PATH\n'
  printf 'exec '; quote "$NODE"; printf ' '; quote "$RELEASE/beat.js"; printf ' "$@"\n'
} > "$SHIM"
chmod 755 "$SHIM"
"$SHIM" help >/dev/null
if [ -e "$BIN/beat" ]; then cp -p "$BIN/beat" "$DATA/previous-launcher"; fi
# Atomic switch: an unsuccessful install never points beat at a partial release.
mv -f "$SHIM" "$BIN/beat"
SHIM=
ENV_FILE=$DATA/env
{
  printf '%s\n' '# beat-cli-managed-path-v1'
  printf 'case ":$PATH:" in *:'; quote "$BIN"; printf ':*) ;; *) PATH='; quote "$BIN"; printf ':"$PATH"; export PATH ;; esac\n'
} > "$ENV_FILE"
if [ "$ADD_PATH" = 1 ]; then
  SOURCE_LINE="[ ! -f $(quote "$ENV_FILE") ] || . $(quote "$ENV_FILE")"
  PROFILE_COUNT=0
  for profile in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -e "$profile" ] || continue
    PROFILE_COUNT=$((PROFILE_COUNT + 1))
    if [ ! -w "$profile" ]; then say "Not writable, left unchanged: $profile"; continue; fi
    if ! grep -Fqx "$SOURCE_LINE" "$profile" 2>/dev/null; then
      printf '\n# BeAT CLI PATH\n%s\n' "$SOURCE_LINE" >> "$profile"
    fi
  done
  # On a fresh account create only the POSIX login profile instead of
  # surprising the user with empty bash and zsh profiles they never used.
  if [ "$PROFILE_COUNT" = 0 ]; then
    printf '# BeAT CLI PATH\n%s\n' "$SOURCE_LINE" > "$HOME/.profile"
  fi
  if command -v fish >/dev/null 2>&1 || [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/fish" ]; then
    FISH_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d
    FISH_FILE=$FISH_DIR/beat-cli.fish
    if [ ! -e "$FISH_FILE" ] || grep -q '^# beat-cli-managed-path-v1$' "$FISH_FILE"; then
      mkdir -p "$FISH_DIR"
      { printf '%s\n' '# beat-cli-managed-path-v1'; printf 'if not contains -- '; quote "$BIN"; printf ' $PATH\n  set -gx PATH '; quote "$BIN"; printf ' $PATH\nend\n'; } > "$FISH_FILE"
    else say "Existing custom fish file left unchanged: $FISH_FILE"; fi
  fi
fi
say ''
say "BeAT installed and verified: $BIN/beat"
say 'Activate PATH in the current sh/bash/zsh terminal:'
printf '  . ' >&2; quote "$ENV_FILE" >&2; printf '\n' >&2
say 'Then connect your BeAT account (not OpenAI): beat login <username>'
say 'Launch: beat codex'
if [ "$SETUP" = 0 ]; then say 'Codex setup was deferred. Run beat setup; Chromium is not required.'; fi
say 'Existing ordinary codex settings and credentials were not modified.'
