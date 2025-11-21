# Release Notes - v1.0.1

**Release Date**: November 21, 2025  
**Type**: Hotfix

## 🐛 Critical Bug Fix

### Fixed: Backup Publication Auto-Selecting Tables Causing Validation Error

**Issue**: When selecting a backup publication (`backup_pub_*`), the UI automatically selected all tables from that publication into `selectedTablesFromPub`. When submitting, this array was sent as `customTables`, which triggered the backend error:

```
Cannot filter tables when using backup publications or existing replication slots
```

Even though the user wasn't manually selecting tables, the auto-selection was being treated as "filtering" by the backend.

**User Impact**:
- Users could not create subscriptions from backup publications via the UI
- Error message appeared even when user didn't touch table selection
- Forced users to use API endpoint directly instead of UI

**Root Cause**:
1. Publication selection checkbox auto-selected all tables: `setSelectedTablesFromPub(new Set([...selectedTablesFromPub, ...pubTables]))`
2. Submit handler sent these tables as `customTables: Array.from(selectedTablesFromPub)`
3. Backend detected `customTables` array with backup publication and blocked it

**The Fix**:

1. **Frontend Submit Logic** (`/pages/subscriptions/new.tsx:316-341`):
   - Detect if any selected publication is a backup publication
   - If yes, send `customTables: undefined` (not the array)
   - This signals backend to use publication as-is without filtering
   ```typescript
   customTables: useExistingPublication
     ? (isUsingBackupPublication ? undefined : Array.from(selectedTablesFromPub))
     : (!excludeMode ? selectedTables : undefined),
   ```

2. **UI Changes** (`/pages/subscriptions/new.tsx:539-556, 559`):
   - Changed warning banner from yellow ⚠️ to green ✅
   - Clear message: "All tables will be automatically included"
   - Hide table selection interface entirely when backup publication selected
   - Updated text: "Table filtering is disabled to maintain data integrity"

3. **Submit Button Validation** (`/pages/subscriptions/new.tsx:1069-1078`):
   - Allow submission when backup publication selected with no table selection
   - Button enabled even if `selectedTablesFromPub.size === 0`
   - Added comment explaining why

4. **Form Validation** (`/pages/subscriptions/new.tsx:314-322`):
   - Skip table selection validation for backup publications
   - Only require table selection for non-backup existing publications

## ✨ User Experience Improvements

### Before (v1.0.0):
- ❌ User selects backup publication
- ❌ Tables auto-selected (hidden from user)
- ❌ Submit triggers error
- ❌ Confusing error message

### After (v1.0.1):
- ✅ User selects backup publication
- ✅ Green banner: "All tables will be automatically included"
- ✅ Table selection UI hidden (no confusion)
- ✅ Submit works immediately
- ✅ Clear UX: what you see is what you get

## 📝 Files Changed

1. `/pages/subscriptions/new.tsx`
   - Updated submit handler (lines 316-341)
   - Updated UI banners (lines 539-556)
   - Hidden table selection for backup pubs (line 559)
   - Fixed submit button validation (lines 1069-1078)
   - Added form validation logic (lines 314-322)

2. `/package.json`
   - Version bumped: `1.0.0` → `1.0.1`

## 🧪 Testing

To verify the fix:

1. Go to "Create New Subscription" page
2. Select "Use existing publication" radio button
3. Check the `backup_pub_*` publication checkbox
4. Verify:
   - ✅ Green banner appears: "All tables will be automatically included"
   - ✅ Table selection interface is hidden
   - ✅ Submit button is enabled
   - ✅ Submission succeeds without error

## 🔄 Migration

No migration required. This is a UI/validation fix. Existing subscriptions are unaffected.

## 📦 Version Info

- **Previous**: v1.0.0
- **Current**: v1.0.1
- **Type**: Hotfix
- **Lines Changed**: ~40

---

**Reported By**: Saulius  
**Fixed By**: Cascade AI
