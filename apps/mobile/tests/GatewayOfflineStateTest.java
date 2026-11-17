package com.mobilecodex.app;

class GatewayOfflineStateTest {
    private static void expect(GatewayOfflineState.Change expected, GatewayOfflineState.Change actual) {
        if (actual != expected) throw new AssertionError("Expected " + expected + ", got " + actual);
    }
    private static GatewayOfflineState.Change down(GatewayOfflineState state, long now) {
        return state.update(now, true, true, false, false, true);
    }
    public static void main(String[] args) {
        GatewayOfflineState state = new GatewayOfflineState();
        state.contact(1_000_000);
        expect(GatewayOfflineState.Change.NONE, state.update(0, true, true, true, false, true));
        expect(GatewayOfflineState.Change.NONE, down(state, 10_000));
        expect(GatewayOfflineState.Change.NONE, down(state, 129_999));
        expect(GatewayOfflineState.Change.SHOW, down(state, 130_000));
        if (state.lastConnectedAt() != 1_000_000) throw new AssertionError("Last success changed during failure");
        expect(GatewayOfflineState.Change.NONE, down(state, 130_001));
        expect(GatewayOfflineState.Change.NONE, down(state, 500_000));
        state.contact(2_000_000);
        expect(GatewayOfflineState.Change.CLEAR, state.update(500_001, true, true, true, false, true));
        expect(GatewayOfflineState.Change.NONE, state.update(500_002, true, true, true, false, true));
        expect(GatewayOfflineState.Change.NONE, down(state, 600_000));
        expect(GatewayOfflineState.Change.SHOW, down(state, 720_000));

        // Phone offline: no warning, no accumulated outage time, and no duplicate warning after a flap.
        expect(GatewayOfflineState.Change.CLEAR, state.update(720_001, true, false, false, false, true));
        expect(GatewayOfflineState.Change.NONE, down(state, 800_000));
        expect(GatewayOfflineState.Change.NONE, down(state, 920_000));
        state.reset();
        expect(GatewayOfflineState.Change.NONE, down(state, 0));
        expect(GatewayOfflineState.Change.NONE, state.update(119_999, true, false, false, false, true));
        expect(GatewayOfflineState.Change.NONE, state.update(999_999, true, false, false, false, true));
        expect(GatewayOfflineState.Change.NONE, down(state, 1_000_000));
        expect(GatewayOfflineState.Change.NONE, down(state, 1_119_999));
        expect(GatewayOfflineState.Change.SHOW, down(state, 1_120_000));

        // Authentication is a distinct outcome, including when an outage notification already exists.
        expect(GatewayOfflineState.Change.CLEAR, state.update(1_120_001, true, true, false, true, true));
        expect(GatewayOfflineState.Change.NONE, state.update(2_000_000, true, true, false, true, true));
        expect(GatewayOfflineState.Change.NONE, down(state, 2_000_001));
        expect(GatewayOfflineState.Change.SHOW, down(state, 2_120_001));

        // Turning off retracts the notification without allowing the same outage to alert again.
        expect(GatewayOfflineState.Change.CLEAR, state.update(2_120_002, true, true, false, false, false));
        expect(GatewayOfflineState.Change.NONE, down(state, 2_200_000));
        expect(GatewayOfflineState.Change.NONE, down(state, 2_320_000));
        state.reset();
        expect(GatewayOfflineState.Change.NONE, state.update(0, true, true, false, false, false));
        expect(GatewayOfflineState.Change.NONE, state.update(500_000, true, true, false, false, false));
        expect(GatewayOfflineState.Change.NONE, down(state, 600_000));
        expect(GatewayOfflineState.Change.NONE, down(state, 719_999));
        expect(GatewayOfflineState.Change.SHOW, down(state, 720_000));

        expect(GatewayOfflineState.Change.CLEAR, state.update(720_001, false, true, false, false, true));
        expect(GatewayOfflineState.Change.NONE, state.update(2_000_000, false, true, false, false, true));
        expect(GatewayOfflineState.Change.NONE, down(state, 3_000_000));
        expect(GatewayOfflineState.Change.SHOW, down(state, 3_120_000));
        expect(GatewayOfflineState.Change.CLEAR, state.reset());
        if (state.lastConnectedAt() != 0) throw new AssertionError("Connection switch retained old timestamp");
        expect(GatewayOfflineState.Change.NONE, down(state, 4_000_000));
        expect(GatewayOfflineState.Change.NONE, down(state, 4_119_999));
        expect(GatewayOfflineState.Change.SHOW, down(state, 4_120_000));
        System.out.println("GatewayOfflineState: threshold, once per outage, recovery, phone network, authentication, settings and lifecycle passed");
    }
}
