#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$DIR"

AUTO_DEPLOY=""
DEPLOY_DESC=""

# Parse command line options
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--deploy)
      AUTO_DEPLOY="yes"
      shift
      ;;
    -n|--no-deploy)
      AUTO_DEPLOY="no"
      shift
      ;;
    -m|--message)
      DEPLOY_DESC="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: ./push_to_gas.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  -d, --deploy             Automatically create a new deployment version after pushing"
      echo "  -n, --no-deploy          Push code only (skip deployment prompt)"
      echo "  -m, --message <desc>     Custom description for the deployment version"
      echo "  -h, --help               Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run './push_to_gas.sh --help' for usage."
      exit 1
      ;;
  esac
done

echo "=========================================================="
echo " 🚀 Google Apps Script Automated Code Uploader"
echo "=========================================================="

# 1. Check for Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is not installed."
  echo "Since Homebrew is installed on your Mac, you can install Node.js with:"
  echo "    brew install node"
  echo ""
  exit 1
fi

# 2. Check for Clasp
CLASP_CMD="clasp"
if ! command -v clasp >/dev/null 2>&1; then
  if command -v npx >/dev/null 2>&1; then
    echo "ℹ️ Using npx @google/clasp..."
    CLASP_CMD="npx @google/clasp"
  else
    echo "❌ Clasp is not installed. Installing globally with npm..."
    npm install -g @google/clasp
  fi
fi

# 3. Check for .clasp.json (Project Script ID)
if [ ! -f ".clasp.json" ]; then
  echo ""
  echo "⚠️ .clasp.json not found."
  echo "To link your Google Apps Script project, enter your Script ID."
  echo "(Found in Google Apps Script Editor -> ⚙️ Project Settings -> Script ID,"
  echo " or in the browser URL: https://script.google.com/d/<SCRIPT_ID>/edit)"
  echo ""
  read -r -p "Enter your Script ID: " SCRIPT_ID

  if [ -z "$SCRIPT_ID" ]; then
    echo "❌ Error: Script ID cannot be empty."
    exit 1
  fi

  cat <<EOF > .clasp.json
{
  "scriptId": "$SCRIPT_ID",
  "rootDir": "."
}
EOF
  echo "✅ Created .clasp.json with Script ID: $SCRIPT_ID"
fi

# 4. Check Clasp Authentication
if [ ! -f "$HOME/.clasprc.json" ]; then
  echo ""
  echo "🔑 Logging in to Google Apps Script via Clasp..."
  echo "⚠️ IMPORTANT: Make sure you have enabled the Apps Script API:"
  echo "👉 https://script.google.com/home/usersettings (Set 'Google Apps Script API' to ON)"
  echo ""
  $CLASP_CMD login
fi

# 5. Push Code
echo ""
echo "📤 Uploading files to Google Apps Script..."
$CLASP_CMD push
echo "✅ Code push complete."

# 6. Optional: Deploy New Version
if [ -z "$AUTO_DEPLOY" ]; then
  echo ""
  read -r -p "🚀 Do you want to create a new deployment version now? [y/N]: " REPLY
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    AUTO_DEPLOY="yes"
  else
    AUTO_DEPLOY="no"
  fi
fi

if [ "$AUTO_DEPLOY" = "yes" ]; then
  echo ""
  echo "📦 Preparing deployment..."

  if [ -z "$DEPLOY_DESC" ]; then
    DEPLOY_DESC="Auto-deploy $(date +'%Y-%m-%d %H:%M:%S')"
  fi

  # Check existing deployments to update rather than create duplicates
  DEPLOYMENTS_OUTPUT=$($CLASP_CMD deployments 2>/dev/null || true)
  EXISTING_DEP_ID=$(echo "$DEPLOYMENTS_OUTPUT" | grep -E '^-\s+AKfy' | grep -v '@HEAD' | head -n 1 | awk '{print $2}' || true)

  if [ -n "$EXISTING_DEP_ID" ]; then
    echo "🔄 Found existing deployment ($EXISTING_DEP_ID)."
    echo "Updating existing deployment to new version (keeps same Web App URL)..."
    
    # Try updating existing deployment directly with clasp deploy -i
    if ! $CLASP_CMD deploy -i "$EXISTING_DEP_ID" -d "$DEPLOY_DESC"; then
      # Fallback: create version first, then redeploy
      echo "Retrying via clasp version + redeploy..."
      VERSION_OUTPUT=$($CLASP_CMD version "$DEPLOY_DESC" || true)
      VERSION_NUM=$(echo "$VERSION_OUTPUT" | grep -oE '[0-9]+' | tail -n 1)
      if [ -n "$VERSION_NUM" ]; then
        $CLASP_CMD redeploy "$EXISTING_DEP_ID" "$VERSION_NUM" "$DEPLOY_DESC"
      else
        $CLASP_CMD deploy -d "$DEPLOY_DESC"
      fi
    fi
    echo "✅ Successfully updated deployment $EXISTING_DEP_ID!"
  else
    echo "🆕 No previous deployment found. Creating new deployment..."
    $CLASP_CMD deploy -d "$DEPLOY_DESC"
  fi

  echo ""
  echo "=========================================================="
  echo "🎉 New version successfully deployed to Google Apps Script!"
  echo "=========================================================="
else
  echo ""
  echo "=========================================================="
  echo "✅ Files uploaded. (Deployment skipped)"
  echo "=========================================================="
  echo "Tip: Run './push_to_gas.sh --deploy' anytime to push and deploy automatically."
fi
