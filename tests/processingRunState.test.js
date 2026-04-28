const assert = require('assert');
const { ProcessingRunState } = require('../src/core/processingRunState');

function createTimerHarness() {
    const timers = [];

    return {
        schedule(fn, delayMs) {
            const handle = { fn, delayMs, cancelled: false };
            timers.push(handle);
            return handle;
        },
        clearSchedule(handle) {
            if (handle) {
                handle.cancelled = true;
            }
        },
        getLatestActiveTimer() {
            for (let i = timers.length - 1; i >= 0; i -= 1) {
                if (!timers[i].cancelled) {
                    return timers[i];
                }
            }
            return null;
        }
    };
}

function runTests() {
    const resets = [];
    const timerHarness = createTimerHarness();
    const tracker = new ProcessingRunState({
        onReset: () => resets.push('reset'),
        schedule: timerHarness.schedule,
        clearSchedule: timerHarness.clearSchedule
    });

    console.log('Test: sequential runs keep per-run completion isolated');
    const firstRun = tracker.startRun({ jobType: 'ANALYZER', total: 2 });
    tracker.markCompleted(firstRun.id);
    assert.deepStrictEqual(tracker.getSnapshot(firstRun.id), {
        id: firstRun.id,
        jobType: 'ANALYZER',
        total: 2,
        completed: 1,
        remaining: 1,
        progress: 50,
        startTime: firstRun.startTime
    });

    tracker.scheduleReset(firstRun.id, 25, () => true);
    const firstResetTimer = timerHarness.getLatestActiveTimer();
    const secondRun = tracker.startRun({ jobType: 'ANALYZER', total: 1 });
    assert.strictEqual(firstResetTimer.cancelled, true);
    assert.strictEqual(tracker.getLatestSnapshot().id, secondRun.id);
    assert.strictEqual(tracker.getSnapshot(firstRun.id).completed, 1);

    console.log('Test: reset waits for idle before clearing latest run');
    tracker.markCompleted(secondRun.id);
    let idle = false;
    tracker.scheduleReset(secondRun.id, 25, () => idle);

    const blockedTimer = timerHarness.getLatestActiveTimer();
    blockedTimer.fn();
    assert.strictEqual(resets.length, 0);
    assert.ok(tracker.getLatestSnapshot());

    idle = true;
    const finalTimer = timerHarness.getLatestActiveTimer();
    finalTimer.fn();
    assert.strictEqual(resets.length, 1);
    assert.strictEqual(tracker.getLatestSnapshot(), null);

    console.log('✅ Processing run state tests passed');
}

runTests();
