#!/bin/bash
#
# Deployment Rollback Script
# Rolls back to a previous Docker image version
#
# Usage: ./rollback.sh [image_tag]
#   image_tag: The Docker image tag to rollback to (default: reads from .previous-tag)
#
# Environment Variables:
#   DEPLOY_PATH: Path to deployment directory (default: /opt/m2m)
#   REGISTRY: Docker registry (default: ghcr.io)
#   IMAGE_NAME: Docker image name (default: <org>/m2m-connector)
#   HEALTH_CHECK_URL: Health check endpoint (default: http://localhost:8080/health)
#   HEALTH_CHECK_TIMEOUT: Timeout in seconds (default: 60)
#

set -euo pipefail

# Configuration
DEPLOY_PATH="${DEPLOY_PATH:-/opt/m2m}"
REGISTRY="${REGISTRY:-ghcr.io}"
IMAGE_NAME="${IMAGE_NAME:-}"
HEALTH_CHECK_URL="${HEALTH_CHECK_URL:-http://localhost:8080/health}"
HEALTH_CHECK_TIMEOUT="${HEALTH_CHECK_TIMEOUT:-60}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Determine image tag to rollback to
get_rollback_tag() {
    local provided_tag="$1"

    if [ -n "$provided_tag" ]; then
        echo "$provided_tag"
        return 0
    fi

    # Try to read from .previous-tag file
    local prev_tag_file="${DEPLOY_PATH}/.previous-tag"
    if [ -f "$prev_tag_file" ]; then
        local tag
        tag=$(cat "$prev_tag_file")
        if [ -n "$tag" ] && [ "$tag" != "none" ]; then
            echo "$tag"
            return 0
        fi
    fi

    return 1
}

# Verify health check passes
verify_health() {
    local timeout=$HEALTH_CHECK_TIMEOUT
    local interval=5
    local attempts=$((timeout / interval))

    log_info "Verifying deployment health (timeout: ${timeout}s)..."

    for i in $(seq 1 $attempts); do
        if curl -sf "$HEALTH_CHECK_URL" > /dev/null 2>&1; then
            log_info "Health check passed!"
            return 0
        fi
        log_info "Attempt $i/$attempts: Waiting for service to be healthy..."
        sleep $interval
    done

    log_error "Health check failed after ${timeout} seconds"
    return 1
}

# Main rollback function
rollback() {
    local target_tag="$1"

    if [ -z "$IMAGE_NAME" ]; then
        log_error "IMAGE_NAME environment variable is required"
        exit 1
    fi

    local full_image="${REGISTRY}/${IMAGE_NAME}:${target_tag}"

    log_info "=========================================="
    log_info "Starting Rollback"
    log_info "=========================================="
    log_info "Target image: ${full_image}"
    log_info "Deploy path: ${DEPLOY_PATH}"
    log_info ""

    # Navigate to deployment directory
    if [ ! -d "$DEPLOY_PATH" ]; then
        log_error "Deployment directory not found: ${DEPLOY_PATH}"
        exit 1
    fi
    cd "$DEPLOY_PATH"

    # Stop current containers
    log_info "Stopping current containers..."
    docker-compose -f docker-compose-production.yml stop connector || true

    # Pull the rollback image
    log_info "Pulling rollback image: ${full_image}"
    if ! docker pull "$full_image"; then
        log_error "Failed to pull image: ${full_image}"
        exit 1
    fi

    # Start containers with rollback image
    log_info "Starting containers with rollback image..."
    export IMAGE_TAG="$target_tag"
    export IMAGE_REGISTRY="${REGISTRY}/${IMAGE_NAME}"
    docker-compose -f docker-compose-production.yml up -d connector

    # Verify health
    if verify_health; then
        log_info "=========================================="
        log_info "Rollback Successful!"
        log_info "=========================================="
        log_info "Rolled back to: ${full_image}"
        log_info "Time: $(date -u)"
        exit 0
    else
        log_error "=========================================="
        log_error "Rollback Failed!"
        log_error "=========================================="
        log_error "Health check did not pass after rollback"
        log_error "Manual intervention may be required"
        exit 1
    fi
}

# Display usage
usage() {
    echo "Usage: $0 [image_tag]"
    echo ""
    echo "Arguments:"
    echo "  image_tag    Docker image tag to rollback to (optional)"
    echo "               If not provided, reads from .previous-tag file"
    echo ""
    echo "Environment Variables:"
    echo "  DEPLOY_PATH          Deployment directory (default: /opt/m2m)"
    echo "  REGISTRY             Docker registry (default: ghcr.io)"
    echo "  IMAGE_NAME           Docker image name (required)"
    echo "  HEALTH_CHECK_URL     Health endpoint (default: http://localhost:8080/health)"
    echo "  HEALTH_CHECK_TIMEOUT Timeout in seconds (default: 60)"
    echo ""
    echo "Example:"
    echo "  IMAGE_NAME=myorg/m2m-connector $0 v1.2.3"
    echo "  IMAGE_NAME=myorg/m2m-connector $0  # Uses .previous-tag"
}

# Main entry point
main() {
    local provided_tag="${1:-}"

    if [ "$provided_tag" = "-h" ] || [ "$provided_tag" = "--help" ]; then
        usage
        exit 0
    fi

    local target_tag
    if ! target_tag=$(get_rollback_tag "$provided_tag"); then
        log_error "No rollback target specified and no .previous-tag file found"
        usage
        exit 1
    fi

    rollback "$target_tag"
}

main "$@"
