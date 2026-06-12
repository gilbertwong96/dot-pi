#!/bin/sh

set -u

DOT_PI_SOURCE="git:github.com/dannote/dot-pi"
PI_PACKAGE="@earendil-works/pi-coding-agent"

YES=0
DRY_RUN=0
LOCAL=0
INSTALL_PI=1
INSTALL_AGENT_BROWSER="ask"
INSTALL_COMPANIONS=0

usage() {
  cat <<'EOF'
Usage: sh install.sh [options]

Options:
  -y, --yes             Run non-interactively with recommended defaults
      --dry-run         Print commands without running them
      --local           Install dot-pi into the current project with pi install -l
      --no-pi-install   Do not install Pi if the pi command is missing
      --agent-browser   Install agent-browser without prompting
      --no-agent-browser
                        Skip agent-browser setup
      --with-companions Install optional companion Pi packages without prompting
  -h, --help            Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes)
      YES=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --local)
      LOCAL=1
      ;;
    --no-pi-install)
      INSTALL_PI=0
      ;;
    --agent-browser)
      INSTALL_AGENT_BROWSER=1
      ;;
    --no-agent-browser)
      INSTALL_AGENT_BROWSER=0
      ;;
    --with-companions)
      INSTALL_COMPANIONS=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

log() {
  printf '%s\n' "$*"
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

has() {
  command -v "$1" >/dev/null 2>&1
}

print_cmd() {
  printf '+ '
  for arg in "$@"; do
    case "$arg" in
      *[!A-Za-z0-9_/:=.,@%+-]*) printf "'%s' " "$arg" ;;
      *) printf '%s ' "$arg" ;;
    esac
  done
  printf '\n'
}

run() {
  print_cmd "$@"
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@"
  fi
}

run_shell() {
  printf '+ %s\n' "$1"
  if [ "$DRY_RUN" -eq 0 ]; then
    sh -c "$1"
  fi
}

ask_yes_no() {
  question=$1
  default=${2:-n}

  if [ "$YES" -eq 1 ]; then
    case "$default" in
      y|Y) return 0 ;;
      *) return 1 ;;
    esac
  fi

  if [ ! -r /dev/tty ]; then
    case "$default" in
      y|Y) return 0 ;;
      *) return 1 ;;
    esac
  fi

  if [ "$default" = "y" ] || [ "$default" = "Y" ]; then
    prompt="Y/n"
  else
    prompt="y/N"
  fi

  while :; do
    printf '%s [%s] ' "$question" "$prompt" >/dev/tty
    IFS= read -r answer </dev/tty || answer=""
    case "$answer" in
      "") answer=$default ;;
    esac
    case "$answer" in
      y|Y|yes|YES|Yes) return 0 ;;
      n|N|no|NO|No) return 1 ;;
      *) printf 'Please answer yes or no.\n' >/dev/tty ;;
    esac
  done
}

os_name() {
  uname_s=$(uname -s 2>/dev/null || echo unknown)
  case "$uname_s" in
    Darwin) echo macos ;;
    Linux)
      if [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
        echo wsl
      else
        echo linux
      fi
      ;;
    *) echo "$uname_s" ;;
  esac
}

install_pi() {
  if has pi; then
    log "Pi is already installed: $(command -v pi)"
    return 0
  fi

  if [ "$INSTALL_PI" -eq 0 ]; then
    fail "pi command not found. Install Pi first, then rerun this script."
  fi

  log "Pi is not installed. Installing Pi..."

  if has curl; then
    run_shell "curl -fsSL https://pi.dev/install.sh | sh"
  elif has wget; then
    run_shell "wget -qO- https://pi.dev/install.sh | sh"
  elif has npm; then
    run npm install -g --ignore-scripts "$PI_PACKAGE"
  else
    fail "Need curl, wget, or npm to install Pi. Install one of them and rerun this script."
  fi

  if [ "$DRY_RUN" -eq 0 ] && ! has pi; then
    fail "Pi install finished, but pi is still not on PATH. Open a new shell or fix PATH, then rerun this script."
  fi
}

install_dot_pi() {
  log "Installing dot-pi package..."
  if [ "$LOCAL" -eq 1 ]; then
    run pi install "$DOT_PI_SOURCE" -l
  else
    run pi install "$DOT_PI_SOURCE"
  fi
}

install_agent_browser() {
  if [ "$INSTALL_AGENT_BROWSER" = "0" ]; then
    log "Skipping agent-browser."
    return 0
  fi

  if [ "$INSTALL_AGENT_BROWSER" = "ask" ]; then
    if ! ask_yes_no "Install and initialize agent-browser?" y; then
      log "Skipping agent-browser."
      return 0
    fi
  fi

  if ! has agent-browser; then
    if ! has npm; then
      warn "npm is required to install agent-browser. Skipping."
      warn "Later, run: npm install -g agent-browser && agent-browser install"
      return 0
    fi
    run npm install -g agent-browser
  else
    log "agent-browser is already installed: $(command -v agent-browser)"
  fi

  run agent-browser install
}

install_pi_package() {
  source=$1
  label=$2

  if [ "$INSTALL_COMPANIONS" -eq 1 ] || ask_yes_no "Install optional companion $label?" n; then
    run pi install "$source"
  else
    log "Skipping $label."
  fi
}

install_companions() {
  install_pi_package "npm:pi-elixir" "pi-elixir"
  install_pi_package "npm:pi-subagents" "pi-subagents"
  install_pi_package "npm:pi-context" "pi-context"

  if [ "$(os_name)" = "macos" ]; then
    install_pi_package "git:github.com/injaneity/pi-computer-use@v0.2.6" "pi-computer-use"
  fi
}

print_summary() {
  cat <<'EOF'

Done.

Next steps:
  1. Start Pi: pi
  2. Authenticate if needed: /login
  3. Review enabled resources: pi config
  4. Optional API keys can go in ~/.pi/agent/env.jsonc for tools like Exa and Context7.

Update later with:
  pi update
EOF
}

log "dot-pi installer"
log "Detected platform: $(os_name)"
log ""

install_pi
install_dot_pi
install_agent_browser
install_companions
print_summary
