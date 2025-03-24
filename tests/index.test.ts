import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import * as Minio from "minio";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { S3Mutex } from "../src/index";

// Configure MinIO client from environment variables
const minioClient = new Minio.Client({
	endPoint: process.env.MINIO_ENDPOINT || "localhost",
	port: Number.parseInt(process.env.MINIO_PORT || "9000"),
	useSSL: process.env.MINIO_USE_SSL === "true",
	accessKey: process.env.MINIO_ACCESS_KEY || "root",
	secretKey: process.env.MINIO_SECRET_KEY || "password",
});

// Configure AWS S3 client for MinIO
const s3Client = new S3Client({
	endpoint: `http://${process.env.MINIO_ENDPOINT || "localhost"}:${process.env.MINIO_PORT || "9000"}`,
	region: "us-east-1",
	credentials: {
		accessKeyId: process.env.MINIO_ACCESS_KEY || "root",
		secretAccessKey: process.env.MINIO_SECRET_KEY || "password",
	},
	forcePathStyle: true, // Required for MinIO
});

// Generate unique bucket name for test isolation
const testBucket = `test-bucket-${Date.now()}`;
const testObject = "test-file.txt";
const testContent = Buffer.from("Hello, MinIO!");
const lockBucket = `locks-bucket-${Date.now()}`;

// Utility function to check if a bucket exists and is accessible via S3 client
async function ensureBucketExists(bucketName: string): Promise<boolean> {
	try {
		await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
		return true;
	} catch (error) {
		console.error(`Bucket ${bucketName} not accessible via S3 client:`, error);
		return false;
	}
}

describe("MinIO End-to-End Tests", () => {
	beforeAll(async () => {
		// Create test bucket
		await minioClient.makeBucket(testBucket, "us-east-1");
		await minioClient.makeBucket(lockBucket, "us-east-1");

		// Verify the buckets are accessible via S3 client
		// Add a small delay to allow bucket creation to propagate
		await new Promise((resolve) => setTimeout(resolve, 1000));

		const testBucketExists = await ensureBucketExists(testBucket);
		const lockBucketExists = await ensureBucketExists(lockBucket);

		expect(testBucketExists).toBe(true);
		expect(lockBucketExists).toBe(true);
	});

	afterAll(async () => {
		try {
			// Clean objects first
			await minioClient.removeObject(testBucket, testObject).catch(() => {});

			// Cleanup test buckets
			await minioClient.removeBucket(testBucket);
			await minioClient.removeBucket(lockBucket);
		} catch (error) {
			console.error("Error cleaning up buckets:", error);
		}
	});

	test("should upload object to bucket", async () => {
		const etag = await minioClient.putObject(
			testBucket,
			testObject,
			testContent,
			testContent.length,
		);
		expect(etag).toBeDefined();
	});

	test("should retrieve object metadata", async () => {
		const stats = await minioClient.statObject(testBucket, testObject);
		expect(stats).toMatchObject({
			size: testContent.length,
			etag: expect.any(String),
		});
	});

	test("should download uploaded object", async () => {
		const stream = await minioClient.getObject(testBucket, testObject);

		const chunks: Buffer[] = [];
		await new Promise((resolve, reject) => {
			stream.on("data", (chunk) => chunks.push(chunk));
			stream.on("end", resolve);
			stream.on("error", reject);
		});

		const receivedContent = Buffer.concat(chunks);
		expect(receivedContent.toString()).toEqual(testContent.toString());
	});

	test("should delete object from bucket", async () => {
		await minioClient.removeObject(testBucket, testObject);

		// Verify object no longer exists
		await expect(
			minioClient.statObject(testBucket, testObject),
		).rejects.toThrow();
	});
});

// Run S3Mutex tests only if bucket verification passes
describe("S3Mutex Tests", () => {
	beforeAll(async () => {
		// Additional verification before running S3Mutex tests
		const lockBucketExists = await ensureBucketExists(lockBucket);
		if (!lockBucketExists) {
			console.warn(
				"Skipping S3Mutex tests because lock bucket is not accessible",
			);
			return;
		}
	});

	// Initialize the S3Mutex with shorter timeouts for testing
	const s3Mutex = new S3Mutex({
		s3Client,
		bucketName: lockBucket,
		maxRetries: 3,
		retryDelayMs: 100,
		lockTimeoutMs: 1000, // 1 second lock timeout for faster tests
	});

	const lockName = `test-lock-${Date.now()}`;

	// Cleanup after all tests
	afterEach(async () => {
		// Force release any remaining locks
		await s3Mutex.releaseLock(lockName, true).catch(() => {
			// Ignore errors during cleanup
		});
	});

	test("should acquire and release a lock", async () => {
		// Verify bucket accessibility again to make debugging easier
		const bucketAccessible = await ensureBucketExists(lockBucket);
		if (!bucketAccessible) {
			console.warn("Skipping test because lock bucket is not accessible");
			return;
		}

		// Acquire the lock
		const acquired = await s3Mutex.acquireLock(lockName);
		expect(acquired).toBe(true);

		// Check if the lock is held
		const isLocked = await s3Mutex.isLocked(lockName);
		expect(isLocked).toBe(true);

		// Check if we own the lock
		const isOwnedByUs = await s3Mutex.isOwnedByUs(lockName);
		expect(isOwnedByUs).toBe(true);

		// Release the lock
		const released = await s3Mutex.releaseLock(lockName);
		expect(released).toBe(true);

		// Check that the lock is no longer held
		const isLockedAfterRelease = await s3Mutex.isLocked(lockName);
		expect(isLockedAfterRelease).toBe(false);
	});

	test("should not be able to acquire an already held lock", async () => {
		// Check bucket accessibility
		const bucketAccessible = await ensureBucketExists(lockBucket);
		if (!bucketAccessible) {
			console.warn("Skipping test because lock bucket is not accessible");
			return;
		}

		// Create a second mutex instance (simulating another process)
		const secondMutex = new S3Mutex({
			s3Client,
			bucketName: lockBucket,
			maxRetries: 3,
			retryDelayMs: 100,
			lockTimeoutMs: 1000,
		});

		// First instance acquires the lock
		const acquired = await s3Mutex.acquireLock(lockName);
		expect(acquired).toBe(true);

		// Second instance tries to acquire the same lock
		const secondAcquired = await secondMutex.acquireLock(lockName);
		expect(secondAcquired).toBe(false);

		// First instance releases the lock
		const released = await s3Mutex.releaseLock(lockName);
		expect(released).toBe(true);
	});

	test("should be able to refresh a lock", async () => {
		// Check bucket accessibility
		const bucketAccessible = await ensureBucketExists(lockBucket);
		if (!bucketAccessible) {
			console.warn("Skipping test because lock bucket is not accessible");
			return;
		}

		// Acquire the lock
		const acquired = await s3Mutex.acquireLock(lockName);
		expect(acquired).toBe(true);

		// Refresh the lock
		const refreshed = await s3Mutex.refreshLock(lockName);
		expect(refreshed).toBe(true);

		// Should still own the lock after refresh
		const isOwnedByUs = await s3Mutex.isOwnedByUs(lockName);
		expect(isOwnedByUs).toBe(true);

		// Release the lock
		await s3Mutex.releaseLock(lockName);
	});

	test("should execute a function with a lock and release it afterwards", async () => {
		// Check bucket accessibility
		const bucketAccessible = await ensureBucketExists(lockBucket);
		if (!bucketAccessible) {
			console.warn("Skipping test because lock bucket is not accessible");
			return;
		}

		let executionFlag = false;

		const result = await s3Mutex.withLock(lockName, async () => {
			// Check if lock is held within the function
			const isLocked = await s3Mutex.isLocked(lockName);
			expect(isLocked).toBe(true);

			executionFlag = true;
			return "success";
		});

		// Check that the function was executed
		expect(executionFlag).toBe(true);
		expect(result).toBe("success");

		// Lock should be auto-released after function execution
		const isLockedAfter = await s3Mutex.isLocked(lockName);
		expect(isLockedAfter).toBe(false);
	});

	test("should handle lock expiration", async () => {
		// Check bucket accessibility
		const bucketAccessible = await ensureBucketExists(lockBucket);
		if (!bucketAccessible) {
			console.warn("Skipping test because lock bucket is not accessible");
			return;
		}

		// Create a mutex with very short lock timeout
		const shortTimeoutMutex = new S3Mutex({
			s3Client,
			bucketName: lockBucket,
			lockTimeoutMs: 500, // 500ms timeout
			maxRetries: 3,
			retryDelayMs: 100,
		});

		// First instance acquires the lock
		const acquired = await shortTimeoutMutex.acquireLock(lockName);
		expect(acquired).toBe(true);

		// Wait for the lock to expire
		await new Promise((resolve) => setTimeout(resolve, 600));

		// Second instance should be able to acquire the expired lock
		const secondAcquired = await s3Mutex.acquireLock(lockName);
		expect(secondAcquired).toBe(true);

		// Clean up
		await s3Mutex.releaseLock(lockName);
	});

	test("should handle concurrent lock attempts", async () => {
		// Check bucket accessibility
		const bucketAccessible = await ensureBucketExists(lockBucket);
		if (!bucketAccessible) {
			console.warn("Skipping test because lock bucket is not accessible");
			return;
		}

		// Create multiple mutex instances
		const mutexes = Array.from(
			{ length: 5 },
			() =>
				new S3Mutex({
					s3Client,
					bucketName: lockBucket,
					maxRetries: 3,
					retryDelayMs: 100,
					lockTimeoutMs: 1000,
				}),
		);

		// Try to acquire locks concurrently
		const results = await Promise.all(
			mutexes.map((mutex) => mutex.acquireLock(lockName)),
		);

		// Exactly one mutex should acquire the lock
		const successCount = results.filter(Boolean).length;
		expect(successCount).toBe(1);

		// Find which mutex acquired the lock and release it
		const acquiredIndex = results.findIndex((result) => result === true);
		if (acquiredIndex >= 0) {
			await mutexes[acquiredIndex].releaseLock(lockName);
		}
	});

	test("should force release a lock held by another instance", async () => {
		// Check bucket accessibility
		const bucketAccessible = await ensureBucketExists(lockBucket);
		if (!bucketAccessible) {
			console.warn("Skipping test because lock bucket is not accessible");
			return;
		}

		// Create another mutex instance
		const otherMutex = new S3Mutex({
			s3Client,
			bucketName: lockBucket,
			maxRetries: 3,
			retryDelayMs: 100,
			lockTimeoutMs: 1000,
		});

		// Other instance acquires the lock
		const acquired = await otherMutex.acquireLock(lockName);
		expect(acquired).toBe(true);

		// Our instance can't acquire the lock normally
		const ourAcquired = await s3Mutex.acquireLock(lockName);
		expect(ourAcquired).toBe(false);

		// Force release the lock
		const forceReleased = await s3Mutex.releaseLock(lockName, true);
		expect(forceReleased).toBe(true);

		// Now we should be able to acquire the lock
		const acquiredAfterForce = await s3Mutex.acquireLock(lockName);
		expect(acquiredAfterForce).toBe(true);

		// Clean up
		await s3Mutex.releaseLock(lockName);
	});

	test("should completely delete a lock file", async () => {
		// Check bucket accessibility
		const bucketAccessible = await ensureBucketExists(lockBucket);
		if (!bucketAccessible) {
			console.warn("Skipping test because lock bucket is not accessible");
			return;
		}

		// Create a unique lock for this test
		const testLockName = `delete-test-lock-${Date.now()}`;

		// First acquire the lock so it exists
		const acquired = await s3Mutex.acquireLock(testLockName);
		expect(acquired).toBe(true);

		// Now delete it
		const deleted = await s3Mutex.deleteLock(testLockName);
		expect(deleted).toBe(true);

		// Verify it's gone by trying to check if it's locked
		// This should return false but not throw an error
		const isLocked = await s3Mutex.isLocked(testLockName);
		expect(isLocked).toBe(false);

		// Try to delete a lock that doesn't exist
		const nonExistentLockName = `non-existent-lock-${Date.now()}`;
		const deletedNonExistent = await s3Mutex.deleteLock(nonExistentLockName);
		expect(deletedNonExistent).toBe(true); // Should return true since the lock doesn't exist
	});

	test("should not refresh an expired lock", async () => {
		// Check bucket accessibility
		const bucketAccessible = await ensureBucketExists(lockBucket);
		if (!bucketAccessible) {
			console.warn("Skipping test because lock bucket is not accessible");
			return;
		}

		// Create a mutex with very short lock timeout
		const shortTimeoutMutex = new S3Mutex({
			s3Client,
			bucketName: lockBucket,
			lockTimeoutMs: 300, // 300ms timeout
			maxRetries: 3,
			retryDelayMs: 100,
		});

		// Create a unique lock for this test
		const testLockName = `refresh-test-lock-${Date.now()}`;

		// Acquire the lock
		const acquired = await shortTimeoutMutex.acquireLock(testLockName);
		expect(acquired).toBe(true);

		// Wait for the lock to expire
		await new Promise((resolve) => setTimeout(resolve, 400));

		// Try to refresh the lock - should fail because it's expired
		const refreshed = await shortTimeoutMutex.refreshLock(testLockName);
		expect(refreshed).toBe(false);

		// Clean up
		await shortTimeoutMutex.deleteLock(testLockName, true);
	});

	test("should handle errors in withLock function", async () => {
		// Check bucket accessibility
		const bucketAccessible = await ensureBucketExists(lockBucket);
		if (!bucketAccessible) {
			console.warn("Skipping test because lock bucket is not accessible");
			return;
		}

		// Create a unique lock for this test
		const testLockName = `error-test-lock-${Date.now()}`;

		// Use withLock with a function that throws an error
		let error: unknown;
		try {
			await s3Mutex.withLock(testLockName, async () => {
				// Check if lock is held within the function
				const isLocked = await s3Mutex.isLocked(testLockName);
				expect(isLocked).toBe(true);

				// Throw an error
				throw new Error("Test error");
			});
		} catch (e) {
			error = e;
		}

		// Verify that the error was propagated
		expect(error).toBeDefined();
		expect((error as Error).message).toBe("Test error");

		// Check that the lock was properly released despite the error
		const isLockedAfter = await s3Mutex.isLocked(testLockName);
		expect(isLockedAfter).toBe(false);
	});

	test("should find and clean up stale locks", async () => {
		// Check bucket accessibility
		const bucketAccessible = await ensureBucketExists(lockBucket);
		if (!bucketAccessible) {
			console.warn("Skipping test because lock bucket is not accessible");
			return;
		}

		// Create a unique prefix for this test to avoid interference
		const testPrefix = `cleanup-test-${Date.now()}/`;

		// Create a mutex with this prefix
		const cleanupMutex = new S3Mutex({
			s3Client,
			bucketName: lockBucket,
			keyPrefix: testPrefix,
			lockTimeoutMs: 500, // Short timeout for testing
			maxRetries: 3,
			retryDelayMs: 100,
		});

		// Create several locks
		const lockNames = Array.from({ length: 3 }, (_, i) => `test-lock-${i}`);

		// Acquire all locks
		await Promise.all(lockNames.map((name) => cleanupMutex.acquireLock(name)));

		// Wait for locks to expire
		await new Promise((resolve) => setTimeout(resolve, 600));

		// First do a dry run
		const dryRunResult = await cleanupMutex.cleanupStaleLocks({
			prefix: testPrefix,
			dryRun: true,
		});

		// Should have found stale locks but not cleaned them
		expect(dryRunResult.total).toBeGreaterThanOrEqual(3);
		expect(dryRunResult.stale).toBeGreaterThanOrEqual(3);
		expect(dryRunResult.cleaned).toBe(0);

		// Now do a real cleanup
		const cleanupResult = await cleanupMutex.cleanupStaleLocks({
			prefix: testPrefix,
		});

		// Should have cleaned up the stale locks
		expect(cleanupResult.total).toBeGreaterThanOrEqual(3);
		expect(cleanupResult.stale).toBeGreaterThanOrEqual(3);
		expect(cleanupResult.cleaned).toBeGreaterThanOrEqual(3);

		// Verify locks are gone
		for (const name of lockNames) {
			const isLocked = await cleanupMutex.isLocked(name);
			expect(isLocked).toBe(false);
		}
	});

	test("should handle lock acquisition with priorities", async () => {
		// Check bucket accessibility
		const bucketAccessible = await ensureBucketExists(lockBucket);
		if (!bucketAccessible) {
			console.warn("Skipping test because lock bucket is not accessible");
			return;
		}

		// Create a unique lock for this test
		const priorityLockName = `priority-test-lock-${Date.now()}`;

		// Create two mutex instances
		const lowPriorityMutex = new S3Mutex({
			s3Client,
			bucketName: lockBucket,
			maxRetries: 3,
			retryDelayMs: 100,
			lockTimeoutMs: 1000,
		});

		const highPriorityMutex = new S3Mutex({
			s3Client,
			bucketName: lockBucket,
			maxRetries: 3,
			retryDelayMs: 100,
			lockTimeoutMs: 1000,
		});

		// Low priority acquires the lock first
		const lowAcquired = await lowPriorityMutex.acquireLock(
			priorityLockName,
			undefined,
			1,
		);
		expect(lowAcquired).toBe(true);

		// High priority tries to acquire the same lock with higher priority
		// In a real deadlock scenario, this might succeed, but in our test it will still fail
		// since we don't have a complete deadlock detection system
		const highAcquired = await highPriorityMutex.acquireLock(
			priorityLockName,
			undefined,
			10,
		);
		expect(highAcquired).toBe(false);

		// Release the lock
		await lowPriorityMutex.releaseLock(priorityLockName);

		// Now high priority should be able to acquire it
		const highAcquiredAfter = await highPriorityMutex.acquireLock(
			priorityLockName,
			undefined,
			10,
		);
		expect(highAcquiredAfter).toBe(true);

		// Clean up
		await highPriorityMutex.releaseLock(priorityLockName);
	});

	test("should handle clock skew tolerance", async () => {
		// Check bucket accessibility
		const bucketAccessible = await ensureBucketExists(lockBucket);
		if (!bucketAccessible) {
			console.warn("Skipping test because lock bucket is not accessible");
			return;
		}

		// Create a unique lock for this test
		const skewLockName = `skew-test-lock-${Date.now()}`;

		// Create a mutex with specific clock skew tolerance
		const skewMutex = new S3Mutex({
			s3Client,
			bucketName: lockBucket,
			lockTimeoutMs: 1000,
			clockSkewToleranceMs: 200, // 200ms tolerance
			maxRetries: 3,
			retryDelayMs: 100,
		});

		// Acquire the lock
		const acquired = await skewMutex.acquireLock(skewLockName);
		expect(acquired).toBe(true);

		// Wait for just less than the lock timeout
		await new Promise((resolve) => setTimeout(resolve, 900));

		// Another mutex with no tolerance should still see the lock as valid
		const noToleranceMutex = new S3Mutex({
			s3Client,
			bucketName: lockBucket,
			lockTimeoutMs: 1000,
			clockSkewToleranceMs: 0,
			maxRetries: 3,
			retryDelayMs: 100,
		});

		const secondAcquired = await noToleranceMutex.acquireLock(skewLockName);
		// Should fail because the lock is still valid for a mutex without skew tolerance
		expect(secondAcquired).toBe(false);

		// Wait for the lock to expire + skew tolerance
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Now the lock should be acquirable
		const thirdAcquired = await noToleranceMutex.acquireLock(skewLockName);
		expect(thirdAcquired).toBe(true);

		// Clean up
		await noToleranceMutex.releaseLock(skewLockName);
	});
});
