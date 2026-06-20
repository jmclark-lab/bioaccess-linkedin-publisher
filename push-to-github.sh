#!/bin/bash
# One-shot script to push the bioaccess LinkedIn Publisher service to GitHub.
# Run from inside the playwright-linkedin-service/ folder.
# Requires: git, a GitHub account with push access to jmclark-lab/bioaccess-linkedin-publisher

set -e

REPO_URL="https://github.com/jmclark-lab/bioaccess-linkedin-publisher.git"
# For SSH (preferred if you have SSH keys set up):
# REPO_URL="git@github.com:jmclark-lab/bioaccess-linkedin-publisher.git"

# Initialize git if not already done
if [ ! -d ".git" ]; then
  git init
  git branch -m main
fi

# Stage everything
git add .

# Commit
git commit -m "Initial commit — bioaccess LinkedIn Newsletter Publisher service" || echo "Nothing new to commit"

# Set remote (overwrites if already set)
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"

# Push
git push -u origin main

echo ""
echo "✅ Pushed to https://github.com/jmclark-lab/bioaccess-linkedin-publisher"
echo ""
echo "Next steps:"
echo "  1. Go to railway.app → New Project → Deploy from GitHub repo"
echo "  2. Select jmclark-lab/bioaccess-linkedin-publisher"
echo "  3. Add environment variables (see RUNBOOK.md Section 1)"
echo "  4. Add Volume: mount path /data"
echo "  5. Once deployed, bootstrap LinkedIn session (RUNBOOK.md Section 2)"
