#!/bin/bash
set -euo pipefail

# Script to view timing logs for subscription tables endpoint
# Usage: ./scripts/view-timing-logs.sh [namespace] [pod-name-pattern] [subscription-id]

NAMESPACE="${1:-reya-mainnet}"
POD_PATTERN="${2:-monitoring-dashboard}"
SUBSCRIPTION_ID="${3:-}"

echo "========================================="
echo "Viewing Timing Logs for Subscription Tables"
echo "========================================="
echo ""

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "❌ Error: kubectl not found. Please install kubectl first."
    exit 1
fi

# Find the pod
PODS=$(kubectl get pods -n "$NAMESPACE" -o name | grep "$POD_PATTERN" || echo "")

if [[ -z "$PODS" ]]; then
    echo "❌ No pods found matching pattern '$POD_PATTERN' in namespace '$NAMESPACE'"
    exit 1
fi

POD_NAME=$(echo "$PODS" | head -1 | sed 's|pod/||')
echo "✓ Found pod: $POD_NAME"
echo ""

# Build grep pattern
if [[ -n "$SUBSCRIPTION_ID" ]]; then
    GREP_PATTERN="subscriptions/${SUBSCRIPTION_ID}/tables"
    echo "Filtering for subscription: $SUBSCRIPTION_ID"
else
    GREP_PATTERN="subscriptions/.*/tables.*Step\|TOTAL TIME"
    echo "Showing all subscription tables timing logs"
fi

echo ""
echo "========================================="
echo "Timing Logs"
echo "========================================="
echo ""

# Get logs and filter for timing information
kubectl logs -n "$NAMESPACE" "$POD_NAME" --tail=1000 2>&1 | \
    grep -E "$GREP_PATTERN" | \
    grep -E "(Step|TOTAL TIME|Starting request)" | \
    tail -20

echo ""
echo "========================================="
echo "Recent Full Logs (last 5 requests)"
echo "========================================="
echo ""

# Show full logs for recent requests
kubectl logs -n "$NAMESPACE" "$POD_NAME" --tail=2000 2>&1 | \
    grep -E "$GREP_PATTERN" | \
    tail -50

echo ""
echo "========================================="
echo "Done!"
echo "========================================="
echo ""
echo "To follow logs in real-time:"
echo "  kubectl logs -n $NAMESPACE $POD_NAME -f | grep --line-buffered 'subscriptions/.*/tables'"
echo ""
echo "To filter for a specific subscription:"
echo "  ./scripts/view-timing-logs.sh $NAMESPACE $POD_PATTERN <subscription-id>"
echo ""

