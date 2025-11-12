# PVC Configuration for Backups

## Mount Point

The PVC should be mounted at `/backup` in the container.

This is configured in:
- **Dockerfile**: Creates `/backup` directory and sets `BACKUP_DIR=/backup` environment variable
- **Backup API**: Checks for `/backup` first (Kubernetes), then falls back to `./backup` (local dev)

## Helm Values Configuration

Add the following to your Helm `values.yaml` for the `nextjs-app` chart:

```yaml
# Persistent Volume Claim for backups
persistence:
  enabled: true
  storageClass: "standard"  # or "ssd" for better performance
  size: "100Gi"  # Adjust based on backup size requirements
  accessMode: "ReadWriteOnce"
  mountPath: "/backup"

# Or if the chart uses a different structure:
volumeMounts:
  - name: backup-storage
    mountPath: /backup

volumes:
  - name: backup-storage
    persistentVolumeClaim:
      claimName: monitoring-dashboard-backups
```

## Alternative: Direct PVC Definition

If the Helm chart doesn't support persistence directly, create a PVC separately:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: monitoring-dashboard-backups
  namespace: postgres-replication  # or your namespace
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: standard  # or ssd
  resources:
    requests:
      storage: 100Gi
```

Then reference it in your deployment:

```yaml
spec:
  template:
    spec:
      containers:
      - name: app
        volumeMounts:
        - name: backup-storage
          mountPath: /backup
      volumes:
      - name: backup-storage
        persistentVolumeClaim:
          claimName: monitoring-dashboard-backups
```

## Storage Size Recommendations

- **Minimum**: 50Gi (for small databases, few tables)
- **Recommended**: 100Gi (for medium databases, regular backups)
- **Large**: 500Gi+ (for large databases, frequent backups, long retention)

## Storage Class

- **Standard**: Cost-effective, suitable for backups
- **SSD**: Better performance for frequent backup/restore operations
- **Regional**: For multi-zone availability (if needed)

## Access Mode

- **ReadWriteOnce**: Recommended (single pod can mount)
- **ReadWriteMany**: Only if you need multiple pods to access backups simultaneously

## Notes

- The `/backup` directory is owned by user `nextjs` (UID 1001) in the container
- Backups are stored as `.sql` files with timestamps
- Consider setting up backup retention policies or cleanup jobs
- For production, consider using GCS (Google Cloud Storage) instead of PVC for better scalability

