import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface VersionInfo {
  version: string;
  commitHash: string;
  commitDate: string;
  branch: string;
  isDirty: boolean;
}

let cachedVersion: VersionInfo | null = null;

export function getVersionInfo(): VersionInfo {
  if (cachedVersion) {
    return cachedVersion;
  }

  // Read version from package.json
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const version = packageJson.version || '0.0.0';

  let commitHash = 'unknown';
  let commitDate = 'unknown';
  let branch = 'unknown';
  let isDirty = false;

  try {
    // Get git commit hash
    commitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    
    // Get commit date
    commitDate = execSync('git log -1 --format=%cd --date=iso', { encoding: 'utf-8' }).trim();
    
    // Get current branch
    branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
    
    // Check if working directory is dirty
    const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
    isDirty = status.length > 0;
  } catch (error) {
    // Git commands failed (not a git repo or git not available)
    console.warn('Failed to get git information:', error);
  }

  cachedVersion = {
    version,
    commitHash,
    commitDate,
    branch,
    isDirty,
  };

  return cachedVersion;
}

export function getVersionString(): string {
  const info = getVersionInfo();
  let versionStr = `v${info.version}`;
  
  if (info.commitHash !== 'unknown') {
    versionStr += ` (${info.commitHash}`;
    if (info.isDirty) {
      versionStr += '-dirty';
    }
    versionStr += ')';
  }
  
  return versionStr;
}
