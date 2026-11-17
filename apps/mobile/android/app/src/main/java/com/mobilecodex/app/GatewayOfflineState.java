package com.mobilecodex.app;

/** Pure F5 decision state, driven by the existing F1 service (no network or timers of its own). */
final class GatewayOfflineState {
    static final long DELAY_MS = 120_000;
    enum Change { NONE, SHOW, CLEAR }

    private long unreachableSince = -1;
    private boolean alerted;
    private boolean visible;
    private long lastConnectedAt;

    void contact(long wallTime) { lastConnectedAt = wallTime; }
    long lastConnectedAt() { return lastConnectedAt; }

    Change update(long now, boolean running, boolean phoneNetwork, boolean reachable, boolean unauthorized, boolean enabled) {
        if (!running || unauthorized || reachable) {
            unreachableSince = -1;
            alerted = false;
            return clear();
        }
        if (!phoneNetwork || !enabled) {
            // A phone outage is not evidence that the gateway is down. Start a fresh interval later,
            // but don't alert twice for a gateway outage we have already reported.
            unreachableSince = -1;
            return clear();
        }
        if (unreachableSince < 0) unreachableSince = now;
        if (!alerted && now - unreachableSince >= DELAY_MS) {
            alerted = true;
            visible = true;
            return Change.SHOW;
        }
        return Change.NONE;
    }

    Change reset() {
        unreachableSince = -1;
        alerted = false;
        lastConnectedAt = 0;
        return clear();
    }

    private Change clear() {
        if (!visible) return Change.NONE;
        visible = false;
        return Change.CLEAR;
    }
}
