/**
 * Semaphore.js
 * 
 * A zero-dependency async Semaphore class for strictly controlling the maximum 
 * number of concurrent operations globally. This prevents socket exhaustion 
 * (EMFILE) and HTTP 429 Rate Limits from CDNs.
 */
class Semaphore {
    constructor(max) {
        this.max = max; // Maximum concurrent executions
        this.active = 0; // Currently active executions
        this.queue = []; // Queue for pending executions waiting for a lock
    }

    /**
     * Attempts to acquire a lock. If max concurrency is reached,
     * it queues the request as a Promise and waits until released.
     */
    async acquire() {
        if (this.active < this.max) {
            this.active++;
            return;
        }
        return new Promise((resolve) => this.queue.push(resolve));
    }

    /**
     * Releases a lock, allowing the next queued execution to proceed.
     */
    release() {
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            // Transfer the active lock to the next queued item
            next();
        } else {
            this.active--;
        }
    }

    /**
     * Wrapper for automatically acquiring and releasing the lock around
     * an async function.
     * @param {Function} fn - Async function to execute
     * @returns {Promise<any>}
     */
    async run(fn) {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}

module.exports = Semaphore;
