# S3-Mutex

A distributed locking mechanism for Node.js applications using AWS S3 as the backend storage.

## Features

- **Distributed locking**: Coordinate access across multiple services
- **Deadlock detection**: Priority-based mechanism for deadlock resolution
- **Timeout handling**: Automatic lock expiration with configurable timeouts
- **Lock heartbeat**: Automatic lock refresh during long operations
- **Retry with backoff and jitter**: Configurable retry mechanism
- **Error handling**: Specific handling for S3 service issues
- **Cleanup utilities**: Tools for managing stale locks

> **⚠️ Warning**: S3-based locking has significant limitations compared to purpose-built locking solutions. S3 operations have higher latency and are not optimized for high-frequency lock operations. Consider alternatives like Redis, DynamoDB, or ZooKeeper for mission-critical applications.

## Installation

```bash
npm install s3-mutex
# or
yarn add s3-mutex
# or
pnpm add s3-mutex
```

## Usage

### Basic usage

```typescript
import { S3Client } from "@aws-sdk/client-s3";
import { S3Mutex } from "s3-mutex";

// Initialize S3 client
const s3Client = new S3Client({
  region: "us-east-1",
  // other configuration options
});

// make sure your bucket exists first...

// Create mutex instance
const mutex = new S3Mutex({
  s3Client,
  bucketName: "my-locks-bucket",
  keyPrefix: "locks/", // optional, defaults to "locks/"
});

// Acquire a lock
const acquired = await mutex.acquireLock("my-resource-lock");
if (acquired) {
  try {
    // Do work with the exclusive lock
    await doSomething();
  } finally {
    // Release the lock when done
    await mutex.releaseLock("my-resource-lock");
  }
} else {
  console.log("Failed to acquire lock");
}
```

### Using the withLock helper

The `withLock` helper method simplifies working with locks by automatically releasing them:

```typescript
// Execute a function with an automatic lock
const result = await mutex.withLock("my-resource-lock", async () => {
  // This function is executed only when the lock is acquired
  const data = await processResource();
  return data;
});

if (result === null) {
  // Lock acquisition failed
  console.log("Could not acquire lock");
} else {
  // Lock was acquired, function executed, and lock released
  console.log("Process completed with result:", result);
}
```

## Configuration Options

```typescript
const mutex = new S3Mutex({
  // Required options
  s3Client: s3Client,
  bucketName: "my-locks-bucket",
  
  // Optional configuration with defaults
  keyPrefix: "locks/",          // Prefix for lock keys in S3
  maxRetries: 5,                // Max number of acquisition attempts
  retryDelayMs: 200,            // Base delay between retries
  maxRetryDelayMs: 5000,        // Max delay between retries
  useJitter: true,              // Add randomness to retry delays
  lockTimeoutMs: 60000,         // Lock expiration (1 minute)
  clockSkewToleranceMs: 1000,   // Tolerance for clock differences
});
```

## API Reference

### Constructor

```typescript
new S3Mutex(options: S3MutexOptions)
```

### Methods

- **acquireLock(lockName, timeoutMs?, priority?)**: Acquire a named lock with optional timeout and priority
- **releaseLock(lockName, force?)**: Release a lock, with optional force parameter
- **refreshLock(lockName)**: Refresh a lock's expiration time
- **isLocked(lockName)**: Check if a lock is currently held
- **isOwnedByUs(lockName)**: Check if we own a specific lock
- **deleteLock(lockName, force?)**: Completely remove a lock file
- **withLock(lockName, fn, options?)**: Execute a function with an automatic lock
- **cleanupStaleLocks(options?)**: Find and clean up expired locks

### Lock Priority and Deadlock Prevention

S3-Mutex includes deadlock prevention through priority-based acquisition. When multiple processes attempt to acquire locks, those with higher priority values will be favored if deadlock conditions are detected.

```typescript
// Acquire with priority (higher value = higher priority)
await mutex.acquireLock("resource-lock", undefined, 10);
```

## Advanced Usage

### Handling Stale Locks

```typescript
// Find and clean up stale locks
const results = await mutex.cleanupStaleLocks({
  prefix: "locks/myapp/",  // Optional prefix to limit cleanup scope
  olderThan: Date.now() - 3600000,  // Optional custom age (default is lockTimeoutMs)
  dryRun: true,  // Optional: just report stale locks without deleting
});

console.log(`Found ${results.stale} stale locks out of ${results.total} total locks`);
console.log(`Cleaned up ${results.cleaned} locks`);
```

### Force-releasing a Lock

```typescript
// Force release a lock (use with caution)
await mutex.releaseLock("resource-lock", true);
```

## Best Practices

1. **Set appropriate timeouts**: Configure lock timeouts that match your workload duration
2. **Handle failure gracefully**: Always check if lock acquisition was successful
3. **Use the withLock helper**: Ensures locks are always released, even if errors occur
4. **Implement proper error handling**: Be prepared for S3 service errors and throttling
5. **Run periodic cleanup**: Use the cleanupStaleLocks method to maintain your lock storage
6. **Consider performance implications**: S3 operations have higher latency than in-memory solutions
7. **Test thoroughly under load**: Verify lock reliability under your specific workload conditions
8. **Have a fallback strategy**: Plan for occasional lock failures in production environments
9. **Monitor lock contention**: High contention may indicate need for architectural changes

