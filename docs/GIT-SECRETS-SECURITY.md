# Git Secrets Security Guide

This guide explains how to check for and remove leaked secrets from git history.

## Quick Start

### 1. Install Secret Scanning Tools

```bash
./scripts/install-git-secrets.sh
```

This installs:
- **git-secrets**: Prevents committing secrets in the future
- **git-filter-repo**: For safely rewriting git history
- **truffleHog**: For scanning existing history

### 2. Check Git History for Secrets

```bash
./scripts/check-git-secrets.sh
```

This scans the entire git history for:
- Database connection strings (postgresql://, mysql://)
- Passwords in environment variables
- API keys
- AWS credentials
- GCP service account keys
- JWT tokens
- Other common secret patterns

Results are saved to a temporary file and displayed in the terminal.

### 3. Remove Secrets from History (if found)

⚠️ **WARNING**: This rewrites git history and requires force push!

```bash
./scripts/remove-secrets-from-git.sh
```

This script will:
1. Create a backup branch before making changes
2. Remove secrets using one of three methods:
   - Remove specific files
   - Remove/replace patterns across all files
   - Modify specific commits

## Detailed Instructions

### Checking for Secrets

#### Method 1: Using check-git-secrets.sh (Recommended)

```bash
./scripts/check-git-secrets.sh
```

This comprehensive script:
- Scans all files in git history
- Checks for multiple secret patterns
- Shows commit information where secrets were found
- Provides a detailed report

#### Method 2: Using truffleHog

```bash
# Scan last 100 commits
trufflehog git file://. --since-commit HEAD~100

# Scan entire history
trufflehog git file://. --since-commit $(git rev-list --max-parents=0 HEAD)
```

#### Method 3: Using git-secrets

```bash
# Scan specific file
git secrets --scan path/to/file

# Scan all files
git secrets --scan-history
```

### Removing Secrets from History

#### Option 1: Remove Specific Files

If you accidentally committed a `.env` file or similar:

```bash
./scripts/remove-secrets-from-git.sh
# Choose option 1
# Enter file paths: .env.local, config/secrets.json
```

#### Option 2: Remove Patterns

To replace all instances of a pattern (e.g., database URLs):

```bash
./scripts/remove-secrets-from-git.sh
# Choose option 2
# Pattern: postgresql://[^:]+:[^@]+@
# Replacement: postgresql://[REDACTED]@
```

#### Option 3: Manual Removal with git-filter-repo

For more control:

```bash
# Remove a specific file from all history
git filter-repo --path .env.local --invert-paths --force

# Replace text in all files
git filter-repo --replace-text <(echo "old-secret==>new-secret") --force
```

### After Removing Secrets

1. **Verify the changes**:
   ```bash
   git log --all --oneline
   git show HEAD:path/to/file  # Check a specific file
   ```

2. **Force push to remote** (⚠️ DANGEROUS):
   ```bash
   git push --force --all
   git push --force --tags
   ```

3. **Notify all collaborators**:
   - They need to re-clone or reset their local repos
   - Old history still exists in their clones until they update

4. **Rotate all exposed secrets**:
   - Change database passwords
   - Regenerate API keys
   - Update service account keys
   - Even if you remove secrets from git, anyone who cloned before will still have them

## Prevention

### git-secrets Configuration

After running `install-git-secrets.sh`, git-secrets will:
- Block commits containing secrets
- Scan files before staging
- Warn about potential secrets

### Pre-commit Hook

The installation script sets up git hooks automatically. You can also manually add patterns:

```bash
git secrets --add 'YOUR_PATTERN_HERE'
```

### .gitignore

Ensure sensitive files are in `.gitignore`:
- `.env*`
- `*.pem`
- `*.key`
- `secrets/`
- `backup/`

## Common Secret Patterns

The scanner checks for:

1. **Database URLs**: `postgresql://user:pass@host`
2. **Environment Variables**: `PASSWORD=...`, `DATABASE_URL=...`
3. **API Keys**: `api_key=...`, `secret=...`
4. **AWS Credentials**: `AKIA...`, `aws_secret_access_key=...`
5. **GCP Keys**: Service account JSON files
6. **JWT Tokens**: `eyJ...`
7. **Base64 Strings**: Long encoded strings (>50 chars)

## Troubleshooting

### "Not in a git repository"
Make sure you're in the project root directory.

### "git-filter-repo not found"
Install it: `brew install git-filter-repo` (macOS) or `pip3 install git-filter-repo` (Linux)

### "Permission denied"
Make scripts executable: `chmod +x scripts/*.sh`

### False Positives
Some patterns may match non-secret data. Review the results file carefully before removing anything.

## Best Practices

1. **Never commit secrets** - Use environment variables or secret managers
2. **Scan regularly** - Run the check script before major releases
3. **Use git-secrets** - Prevent future leaks automatically
4. **Rotate secrets** - If secrets were exposed, rotate them immediately
5. **Limit access** - Use private repositories and limit who can clone

## Emergency Response

If secrets are found in a public repository:

1. **Immediately rotate all exposed secrets**
2. **Remove secrets from git history** (this script)
3. **Force push the cleaned history**
4. **Notify all collaborators**
5. **Consider making the repository private** if it was public
6. **Monitor for unauthorized access** to affected services

## Additional Resources

- [git-secrets Documentation](https://github.com/awslabs/git-secrets)
- [git-filter-repo Documentation](https://github.com/newren/git-filter-repo)
- [truffleHog Documentation](https://github.com/trufflesecurity/trufflehog)
- [GitHub's Secret Scanning](https://docs.github.com/en/code-security/secret-scanning)

