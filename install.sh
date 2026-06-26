#!/bin/sh

set -u

DOT_PI_SOURCE="git:github.com/gilbertwong96/dot-pi"
DOT_PI_REF=${DOT_PI_REF:-}
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

Environment:
  DOT_PI_REF            Install a specific git ref/tag, for example v0.2.1
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

dot_pi_source() {
  if [ -n "$DOT_PI_REF" ]; then
    printf '%s@%s\n' "$DOT_PI_SOURCE" "$DOT_PI_REF"
  else
    printf '%s\n' "$DOT_PI_SOURCE"
  fi
}

install_dot_pi() {
  source=$(dot_pi_source)
  log "Installing dot-pi package..."
  if [ "$LOCAL" -eq 1 ]; then
    run pi install "$source" -l
  else
    run pi install "$source"
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
  description=$3
  default=${4:-n}

  if [ "$INSTALL_COMPANIONS" -eq 1 ]; then
    run pi install "$source"
    return 0
  fi

  log ""
  log "$label: $description"
  if ask_yes_no "Install optional companion $label?" "$default"; then
    run pi install "$source"
  else
    log "Skipping $label."
  fi
}

elixir_default() {
  if has elixir || has mix; then
    echo y
  else
    echo n
  fi
}

mise_default() {
  if has mise; then
    echo y
  else
    echo n
  fi
}

install_companions() {
  install_pi_package \
    "npm:pi-elixir" \
    "pi-elixir" \
    "Elixir/Phoenix development tools: BEAM eval, AST search/replace, and runtime introspection." \
    "$(elixir_default)"
  install_pi_package \
    "npm:pi-subagents" \
    "pi-subagents" \
    "Subagent delegation for splitting independent work across isolated Pi sessions." \
    n
  install_pi_package \
    "npm:pi-context" \
    "pi-context" \
    "Context history tags and checkouts for resuming or navigating long-running work." \
    n
  install_pi_package \
    "npm:pi-delete-session" \
    "pi-delete-session" \
    "Bulk session deletion: delete multiple sessions at once, grouped by project, with safety confirmations." \
    n
  install_pi_package \
    "npm:pi-cost" \
    "pi-cost" \
    "Cost dashboard: usage and cost tracking for the pi coding agent." \
    n
  install_pi_package \
    "npm:@capotej/pi-mise" \
    "pi-mise" \
    "Mise auto-activation: trusts and activates mise-managed toolchains when a mise config is present in the project." \
    "$(mise_default)"
  install_pi_package \
    "npm:@sherif-fanous/pi-rtk" \
    "pi-rtk" \
    "Token savings: routes bash commands through rtk (Rust Token Killer) to cut LLM token usage." \
    n
  install_pi_package \
    "npm:pi-token-speed" \
    "pi-token-speed" \
    "Token speed: measures tokens per second via a sliding window." \
    n
  install_pi_package \
    "npm:pi-provider-umans" \
    "pi-provider-umans" \
    "Umans.ai model provider: OpenAI-compatible endpoint with dynamic model discovery." \
    n
  install_pi_package \
    "npm:@sting8k/pi-vcc" \
    "pi-vcc" \
    "Conversation compactor: transcript-preserving structured summaries with no LLM calls." \
    n
  install_pi_package \
    "npm:@mohndoe/pi-atlas" \
    "pi-atlas" \
    "Agent usage dashboard: parses session logs into costs, languages, models, projects, and tools with an interactive /atlas view. All processing is local." \
    n
  install_pi_package \
    "npm:@weiping/pi-superpowers" \
    "pi-superpowers" \
    "Workflow skills: ports 14 Superpowers skills (TDD, debugging, collaboration, brainstorming) to Pi with Chinese trigger support." \
    n

  if [ "$(os_name)" = "macos" ]; then
    install_pi_package \
      "git:github.com/injaneity/pi-computer-use@v0.3.2" \
      "pi-computer-use" \
      "macOS visible-app automation with screenshot, window, and accessibility tools." \
      n
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
