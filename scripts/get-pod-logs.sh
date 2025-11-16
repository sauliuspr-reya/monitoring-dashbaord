#!/bin/bash
set -euo pipefail

# Script to get full logs from the monitoring dashboard pod
# Usage: ./scripts/get-pod-logs.sh [namespace] [pod-name-pattern]

NAMESPACE="${1:-reya-mainnet}"
POD_PATTERN="${2:-monitoring-dashboard}"

echo "========================================="
echo "Getting Pod Logs"
echo "========================================="
echo ""
echo "Namespace: $NAMESPACE"
echo "Pod pattern: $POD_PATTERN"
echo ""

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "❌ Error: kubectl not found. Please install kubectl first."
    exit 1
fi

# Find the pod
echo "Finding pods matching pattern '$POD_PATTERN' in namespace '$NAMESPACE'..."
PODS=$(kubectl get pods -n "$NAMESPACE" -o name | grep "$POD_PATTERN" || echo "")

if [[ -z "$PODS" ]]; then
    echo "❌ No pods found matching pattern '$POD_PATTERN' in namespace '$NAMESPACE'"
    echo ""
    echo "Available pods in namespace '$NAMESPACE':"
    kubectl get pods -n "$NAMESPACE" -o name | head -10
    exit 1
fi

# Get the first matching pod (remove 'pod/' prefix)
POD_NAME=$(echo "$PODS" | head -1 | sed 's|pod/||')
echo "✓ Found pod: $POD_NAME"
echo ""

# Check if pod is ready
POD_STATUS=$(kubectl get pod -n "$NAMESPACE" "$POD_NAME" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")

if [[ "$POD_STATUS" != "Running" ]]; then
    echo "⚠️  Pod status: $POD_STATUS"
    echo ""
    echo "Trying to get logs anyway (may show init container logs)..."
    echo ""
    # Try to get logs from init container if main container isn't ready
    if [[ "$POD_STATUS" == "PodInitializing" ]]; then
        echo "Getting init container logs:"
        kubectl logs -n "$NAMESPACE" "$POD_NAME" -c init-backup-dir --tail=50 2>/dev/null || echo "No init container logs available"
        echo ""
    fi
    echo "Attempting to get main container logs (may fail if not ready):"
    echo ""
fi

# Ask user what they want to see (skip if non-interactive)
if [[ -t 0 ]]; then
    echo "What would you like to see?"
    echo "  1) Recent logs (last 100 lines)"
    echo "  2) Full logs (all logs)"
    echo "  3) Follow logs (tail -f, real-time)"
    echo "  4) Logs with timestamps (last 500 lines)"
    echo "  5) Error logs only (grep for errors)"
    echo "  6) Connection timeout errors only"
    echo ""
    read -p "Enter choice [1-6] (default: 1): " -r CHOICE
    CHOICE=${CHOICE:-1}
else
    # Non-interactive mode - default to recent logs
    CHOICE="${3:-1}"
fi

echo ""
echo "========================================="
echo "Logs from $POD_NAME"
echo "========================================="
echo ""

case "$CHOICE" in
    1)
        echo "Recent logs (last 100 lines):"
        kubectl logs -n "$NAMESPACE" "$POD_NAME" --tail=100 2>&1 || kubectl logs -n "$NAMESPACE" "$POD_NAME" -c nextjs-app --tail=100 2>&1 || echo "Could not retrieve logs"
        ;;
    2)
        echo "Full logs:"
        kubectl logs -n "$NAMESPACE" "$POD_NAME" 2>&1 || kubectl logs -n "$NAMESPACE" "$POD_NAME" -c nextjs-app 2>&1 || echo "Could not retrieve logs"
        ;;
    3)
        echo "Following logs (press Ctrl+C to stop):"
        kubectl logs -n "$NAMESPACE" "$POD_NAME" -f 2>&1 || kubectl logs -n "$NAMESPACE" "$POD_NAME" -c nextjs-app -f 2>&1
        ;;
    4)
        echo "Logs with timestamps (last 500 lines):"
        kubectl logs -n "$NAMESPACE" "$POD_NAME" --tail=500 --timestamps 2>&1 || kubectl logs -n "$NAMESPACE" "$POD_NAME" -c nextjs-app --tail=500 --timestamps 2>&1 || echo "Could not retrieve logs"
        ;;
    5)
        echo "Error logs only:"
        kubectl logs -n "$NAMESPACE" "$POD_NAME" --tail=1000 2>&1 | grep -i -E "(error|failed|exception|timeout)" || kubectl logs -n "$NAMESPACE" "$POD_NAME" -c nextjs-app --tail=1000 2>&1 | grep -i -E "(error|failed|exception|timeout)" || echo "No errors found in recent logs"
        ;;
    6)
        echo "Connection timeout errors:"
        kubectl logs -n "$NAMESPACE" "$POD_NAME" --tail=1000 2>&1 | grep -i -E "(timeout|connection|exceeded)" || kubectl logs -n "$NAMESPACE" "$POD_NAME" -c nextjs-app --tail=1000 2>&1 | grep -i -E "(timeout|connection|exceeded)" || echo "No timeout errors found in recent logs"
        ;;
    *)
        echo "Invalid choice. Showing recent logs (last 100 lines):"
        kubectl logs -n "$NAMESPACE" "$POD_NAME" --tail=100 2>&1 || kubectl logs -n "$NAMESPACE" "$POD_NAME" -c nextjs-app --tail=100 2>&1 || echo "Could not retrieve logs"
        ;;
esac

echo ""
echo "========================================="
echo "Done!"
echo "========================================="
echo ""
echo "To get more logs, run:"
echo "  kubectl logs -n $NAMESPACE $POD_NAME --tail=1000"
echo ""
echo "To follow logs in real-time:"
echo "  kubectl logs -n $NAMESPACE $POD_NAME -f"
echo ""
echo "To get logs from a specific container (if pod has multiple):"
echo "  kubectl logs -n $NAMESPACE $POD_NAME -c <container-name>"
echo ""

