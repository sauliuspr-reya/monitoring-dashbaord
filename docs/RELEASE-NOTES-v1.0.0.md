# Release Notes - v1.0.0

## 🔧 Critical Bug Fixes

### Fixed: Backup Slot Restoration Creating Filtered Publications

**Issue**: When creating a subscription from an existing backup slot, the system was incorrectly creating a new filtered publication (`*_subscription_filtered_publication`) instead of using the original backup publication. This broke zero-data-loss restoration.

**Impact**: 
- Data loss during backup restoration
- Replication slot not associated with correct publication
- Changes captured by backup slot were not replicated

**Root Cause**:
The subscription creation endpoint (`/api/subscriptions/create.ts`) was detecting table filtering and creating a new publication, even when using backup publications that are tied to specific replication slots.

**Fix**:
1. **Backend** (`/pages/api/subscriptions/create.ts`):
   - Added detection for backup publications (those starting with `backup_pub_`)
   - Prevents filtered publication creation when:
     - Using an existing backup publication, OR
     - Manual slot name is provided and exists
   - Returns clear error message if user attempts to filter tables with backup publications
   
2. **Frontend** (`/pages/subscriptions/new.tsx`):
   - Added prominent warning banner when backup publication is selected
   - Warns users they must use ALL tables from backup publication
   - Explains that filtering breaks restoration
   - Updated advanced options warning for backup slots

**Related Files**:
- `/pages/api/subscriptions/create.ts`
- `/pages/subscriptions/new.tsx`
- `/docs/BACKUP-SLOT-RESTORATION-FIX.md` (detailed documentation)

**Correct Workflow for Backup Restoration**:
```bash
# Option 1: Use dedicated endpoint (Recommended)
POST /api/subscriptions/create-from-backup
{
  "backupTaskId": "abc-123",
  "subscriptionName": "my_subscription"
}

# Option 2: Via UI
# - Select backup publication (e.g., backup_pub_1763713344411)
# - Enter slot name (e.g., backup_slot_1763713344411)
# - DO NOT select custom tables (use all tables)
# - Set copy_data = false
```

## ✨ New Features

### Version Information Display

Added version information display in the navbar showing:
- **Semantic version** (from package.json)
- **Git commit hash** (short SHA)
- **Git branch** name
- **Commit date**
- **Dirty flag** (indicates uncommitted changes)

**Implementation**:
- New module: `/lib/version.ts` - Extracts version info from git and package.json
- New API endpoint: `/api/version` - Returns version information as JSON
- Updated component: `/components/Navbar.tsx` - Displays version badge with tooltip

**Features**:
- Compact version badge in navbar: `v1.0.0 • abc1234`
- Hover tooltip shows full details (branch, commit date, dirty status)
- Orange asterisk (*) indicates uncommitted changes
- Cached for performance

## 📦 Version Bump

- Updated from `v0.1.0` to `v1.0.0`
- Reflects production-ready status with critical bug fixes

## 🔄 Migration Guide

### If You Have Existing Broken Subscriptions

If you previously created subscriptions with filtered publications from backup slots:

1. **Drop the broken subscription** (on target):
   ```sql
   DROP SUBSCRIPTION your_subscription_name;
   ```

2. **Drop the incorrectly created filtered publication** (on source):
   ```sql
   DROP PUBLICATION your_subscription_filtered_publication;
   ```

3. **Recreate properly**:
   - Use `/api/subscriptions/create-from-backup` endpoint, OR
   - Use UI with ALL tables from backup publication (no filtering)

### Verification

After recreating, verify the subscription is using the correct publication:

```sql
-- On target database
SELECT 
    subname,
    subslotname,
    subpublications
FROM pg_subscription
WHERE subname = 'your_subscription_name';

-- Expected: subpublications should match the original backup publication
-- (e.g., {backup_pub_1763713344411}, NOT a filtered publication)
```

## 📝 Documentation

New documentation added:
- `/docs/BACKUP-SLOT-RESTORATION-FIX.md` - Detailed explanation of the fix
- `/docs/BACKUP-TO-SUBSCRIPTION-WORKFLOW.md` - Updated with warnings (existing)

## 🎯 Breaking Changes

None - This is a bug fix release that corrects incorrect behavior.

## 🚀 Upgrade Instructions

1. Pull the latest code
2. Restart the application
3. Version badge will appear in navbar
4. New subscriptions from backup publications will work correctly
5. Review existing subscriptions and fix any that were created with filtered publications

## 🔍 Testing

To test the fix:

1. Create a backup with replication slot
2. Restore the backup to target
3. Create subscription using backup publication
4. Verify no filtered publication was created:
   ```sql
   -- On source
   SELECT pubname FROM pg_publication 
   WHERE pubname LIKE '%_filtered_publication';
   -- Should NOT include your subscription's filtered publication
   ```

## 📊 Metrics

- **Files Changed**: 6
- **Lines Added**: ~200
- **Lines Removed**: ~30
- **Bug Fixes**: 1 critical
- **New Features**: 1 (version display)

---

**Date**: November 21, 2025  
**Author**: Cascade AI  
**Reviewed By**: Saulius
