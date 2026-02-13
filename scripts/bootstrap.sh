#!/bin/bash
# bootstrap.sh - Set up Claude Code on a new machine
#
# Prerequisites:
#   - claude CLI is installed and authenticated
#   - gh CLI is installed and authenticated
#   - Rust/cargo is installed (for ba, sg, wm)
#
# Usage:
#   ./bootstrap.sh [--skills-source <path>]
#
# Options:
#   --skills-source <path>   Copy additional manual skills from local path
#
# Installs:
#   - Cargo tools: ba, sg, wm
#   - Plugins via marketplace: miranda, superego, wm

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

CLAUDE_DIR="${HOME}/.claude"
SKILLS_DIR="${CLAUDE_DIR}/skills"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Parse arguments
SKILLS_SOURCE=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --skills-source)
            SKILLS_SOURCE="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [--skills-source <path>]"
            echo ""
            echo "Options:"
            echo "  --skills-source <path>   Copy skills from local path"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    local missing=()

    if ! command -v claude &>/dev/null; then
        missing+=("claude (Claude Code CLI)")
    fi

    if ! command -v gh &>/dev/null; then
        missing+=("gh (GitHub CLI)")
    fi

    if ! command -v cargo &>/dev/null; then
        missing+=("cargo (Rust toolchain)")
    fi

    if ! command -v jq &>/dev/null; then
        missing+=("jq (JSON processor)")
    fi

    if ! command -v curl &>/dev/null; then
        missing+=("curl")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required tools:"
        for tool in "${missing[@]}"; do
            echo "  - $tool"
        done
        exit 1
    fi

    log_success "All prerequisites met"
}

# Install cargo tools (ba, sg, wm)
install_cargo_tools() {
    log_info "Installing cargo tools..."

    local tools=("ba" "sg" "wm")

    for tool in "${tools[@]}"; do
        if command -v "$tool" &>/dev/null; then
            log_success "$tool already installed ($($tool --version 2>/dev/null || echo 'version unknown'))"
        else
            log_info "Installing $tool..."
            if cargo install "$tool" 2>/dev/null; then
                log_success "$tool installed"
            else
                log_warn "$tool installation failed (may not be published yet)"
            fi
        fi
    done
}

# Install plugins via marketplace
install_plugins() {
    log_info "Installing plugins via marketplace..."

    # Marketplaces to add (GitHub repos)
    local marketplaces=(
        "cloud-atlas-ai/miranda"
        "cloud-atlas-ai/superego"
        "cloud-atlas-ai/wm"
    )

    # Add marketplaces
    for marketplace in "${marketplaces[@]}"; do
        local name="${marketplace##*/}"  # Extract repo name
        log_info "Adding marketplace: $name..."
        if claude plugin marketplace add "$marketplace" 2>/dev/null; then
            log_success "Added marketplace: $name"
        else
            # May already exist, which is fine
            log_info "Marketplace $name already configured or failed to add"
        fi
    done

    # Update marketplaces to get latest manifests
    log_info "Updating marketplace manifests..."
    for marketplace in "${marketplaces[@]}"; do
        local name="${marketplace##*/}"
        claude plugin marketplace update "$name" 2>/dev/null || true
    done

    # Plugins to install (plugin@marketplace format)
    # Convention: plugin name matches marketplace name (e.g., miranda plugin from miranda marketplace)
    local plugins=(
        "miranda@miranda"
        "superego@superego"
        "wm@wm"
    )

    # Install plugins
    for plugin in "${plugins[@]}"; do
        log_info "Installing plugin: $plugin..."
        if claude plugin install "$plugin" 2>/dev/null; then
            log_success "Installed plugin: $plugin"
        else
            log_warn "Failed to install $plugin (may already be installed)"
        fi
    done
}

# Set up skills directory (for additional manual skills)
setup_skills() {
    log_info "Setting up skills..."

    mkdir -p "$SKILLS_DIR"

    if [[ -n "$SKILLS_SOURCE" ]]; then
        # Copy from provided source
        if [[ ! -d "$SKILLS_SOURCE" ]]; then
            log_error "Skills source not found: $SKILLS_SOURCE"
            exit 1
        fi
        log_info "Copying additional skills from $SKILLS_SOURCE..."
        # Use /. to handle hidden files and empty directories correctly
        if cp -r "$SKILLS_SOURCE"/. "$SKILLS_DIR/" 2>/dev/null; then
            log_success "Skills copied from $SKILLS_SOURCE"
        else
            log_warn "Failed to copy skills from $SKILLS_SOURCE (directory may be empty)"
        fi
    fi

    # List installed manual skills (plugins are tracked separately)
    if [[ -d "$SKILLS_DIR" ]]; then
        local skill_count
        skill_count=$(find "$SKILLS_DIR" -name "SKILL.md" 2>/dev/null | wc -l)
        if [[ $skill_count -gt 0 ]]; then
            log_info "Found $skill_count manual skill(s) in $SKILLS_DIR"
        fi
    fi
}

# Print summary
print_summary() {
    echo ""
    echo "========================================"
    echo "Bootstrap Complete"
    echo "========================================"
    echo ""
    echo "Installed:"

    # Cargo tools
    for tool in ba sg wm; do
        if command -v "$tool" &>/dev/null; then
            echo "  [x] $tool"
        else
            echo "  [ ] $tool (not installed)"
        fi
    done

    # Plugins (check actual installation status via installed_plugins.json)
    local plugins_json="${CLAUDE_DIR}/plugins/installed_plugins.json"
    echo ""
    echo "Plugins (via marketplace):"
    for plugin in miranda superego wm; do
        if [[ -f "$plugins_json" ]] && jq -e ".plugins[\"${plugin}@${plugin}\"]" "$plugins_json" &>/dev/null; then
            echo "  [x] $plugin"
        else
            echo "  [ ] $plugin (not installed)"
        fi
    done

    # Manual skills
    if [[ -d "$SKILLS_DIR" ]]; then
        local skill_count
        skill_count=$(find "$SKILLS_DIR" -name "SKILL.md" 2>/dev/null | wc -l)
        if [[ $skill_count -gt 0 ]]; then
            echo ""
            echo "Manual skills: $skill_count"
        fi
    fi

    echo ""
    echo "Configuration:"
    echo "  Plugins: claude plugin list"
    echo "  Config:  ${CLAUDE_DIR}/settings.json"
    echo ""
    echo "Next steps:"
    echo "  1. Verify plugins: claude plugin list"
    echo "  2. Test ba: ba init && ba create 'Test task'"
    echo "  3. Start Claude Code in a project directory"
    echo ""
}

# Main
main() {
    echo ""
    echo "========================================"
    echo "Claude Code Bootstrap"
    echo "========================================"
    echo ""

    check_prerequisites
    install_cargo_tools
    install_plugins
    setup_skills
    print_summary
}

main
