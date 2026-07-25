import assert from 'node:assert';
import { test, describe, beforeEach, afterEach } from 'node:test';
import { KeySemaphore } from './keySemaphore.js';

describe('KeySemaphore', () => {
  describe('basic concurrency enforcement', () => {
    test('enforces max concurrency per key', async () => {
      const semaphore = new KeySemaphore(2, 1000);
      const activeAtPeak: number[] = [];

      // Fire 3 concurrent tasks for the same key — only 2 should run at once
      await Promise.all([
        semaphore.withSlot('key-a', async () => {
          activeAtPeak.push(semaphore.getCurrentActiveSlotCounts()['key-a'] ?? 0);
          await new Promise((r) => setTimeout(r, 30));
        }),
        semaphore.withSlot('key-a', async () => {
          activeAtPeak.push(semaphore.getCurrentActiveSlotCounts()['key-a'] ?? 0);
          await new Promise((r) => setTimeout(r, 30));
        }),
        semaphore.withSlot('key-a', async () => {
          activeAtPeak.push(semaphore.getCurrentActiveSlotCounts()['key-a'] ?? 0);
          await new Promise((r) => setTimeout(r, 30));
        }),
      ]);

      // The semaphore should never exceed maxConcurrency per key
      assert.ok(
        activeAtPeak.every((c) => c <= 2),
        `Active count never exceeded 2: ${activeAtPeak}`,
      );
      assert.equal(semaphore.getTotalActiveSlotCount(), 0);
    });

    test('isolates concurrency limits between keys', async () => {
      const semaphore = new KeySemaphore(1, 1000);
      let peakTotal = 0;

      await Promise.all([
        semaphore.withSlot('key-a', async () => {
          peakTotal = Math.max(peakTotal, semaphore.getTotalActiveSlotCount());
          await new Promise((r) => setTimeout(r, 30));
        }),
        semaphore.withSlot('key-b', async () => {
          peakTotal = Math.max(peakTotal, semaphore.getTotalActiveSlotCount());
          await new Promise((r) => setTimeout(r, 30));
        }),
      ]);

      // Two different keys should both be active concurrently
      assert.equal(peakTotal, 2);
    });
  });

  describe('slot counting', () => {
    test('getCurrentActiveSlotCounts returns only active keys', async () => {
      const semaphore = new KeySemaphore(5, 1000);

      assert.deepEqual(semaphore.getCurrentActiveSlotCounts(), {});

      await semaphore.withSlot('key-x', async () => {
        const counts = semaphore.getCurrentActiveSlotCounts();
        assert.equal(counts['key-x'], 1);
        assert.equal(Object.keys(counts).length, 1);
      });

      assert.deepEqual(semaphore.getCurrentActiveSlotCounts(), {});
    });

    test('getActiveSlotCount returns count for specific key', async () => {
      const semaphore = new KeySemaphore(5, 1000);

      assert.equal(semaphore.getActiveSlotCount('key-y'), 0);

      await semaphore.withSlot('key-y', async () => {
        assert.equal(semaphore.getActiveSlotCount('key-y'), 1);
      });

      assert.equal(semaphore.getActiveSlotCount('key-y'), 0);
    });

    test('getTotalActiveSlotCount sums all active slots', async () => {
      const semaphore = new KeySemaphore(3, 1000);

      let total = 0;
      await Promise.all([
        semaphore.withSlot('key-1', async () => {
          total = semaphore.getTotalActiveSlotCount();
          await new Promise((r) => setTimeout(r, 30));
        }),
        semaphore.withSlot('key-2', async () => {
          total = semaphore.getTotalActiveSlotCount();
          await new Promise((r) => setTimeout(r, 30));
        }),
        semaphore.withSlot('key-3', async () => {
          total = semaphore.getTotalActiveSlotCount();
          await new Promise((r) => setTimeout(r, 30));
        }),
      ]);

      assert.equal(total, 3);
      assert.equal(semaphore.getTotalActiveSlotCount(), 0);
    });
  });

  describe('isAtLimit', () => {
    test('returns true when key is at its concurrency limit', async () => {
      const semaphore = new KeySemaphore(1, 1000);

      await semaphore.withSlot('key-limit', async () => {
        assert.equal(semaphore.isAtLimit('key-limit'), true);
      });

      assert.equal(semaphore.isAtLimit('key-limit'), false);
    });

    test('returns false when key is under its concurrency limit', async () => {
      const semaphore = new KeySemaphore(2, 1000);

      await semaphore.withSlot('key-under', async () => {
        assert.equal(semaphore.isAtLimit('key-under'), false);
      });
    });
  });

  describe('slot release', () => {
    test('releases slot after successful task completion', async () => {
      const semaphore = new KeySemaphore(1, 1000);

      await semaphore.withSlot('key-release', async () => {
        // slot held here
      });

      // Should be able to acquire the slot again
      await semaphore.withSlot('key-release', async () => {
        assert.equal(semaphore.getActiveSlotCount('key-release'), 1);
      });

      assert.equal(semaphore.getActiveSlotCount('key-release'), 0);
    });

    test('releases slot on error', async () => {
      const semaphore = new KeySemaphore(1, 1000);

      let errorCaught = false;
      try {
        await semaphore.withSlot('key-err', async () => {
          throw new Error('test error');
        });
      } catch {
        errorCaught = true;
      }

      assert.ok(errorCaught);
      assert.equal(semaphore.getActiveSlotCount('key-err'), 0);

      // Should be able to acquire the slot again
      await semaphore.withSlot('key-err', async () => {
        assert.equal(semaphore.getActiveSlotCount('key-err'), 1);
      });
    });
  });

  describe('clear', () => {
    test('resets all state', async () => {
      const semaphore = new KeySemaphore(2, 1000);

      // Acquire a slot so we have state
      await semaphore.withSlot('key-clr', async () => {
        assert.equal(semaphore.getActiveSlotCount('key-clr'), 1);
      });

      semaphore.clear();
      assert.equal(semaphore.getTotalActiveSlotCount(), 0);
      assert.equal(semaphore.getActiveSlotCount('key-clr'), 0);
      assert.deepEqual(semaphore.getCurrentActiveSlotCounts(), {});
    });
  });
});
