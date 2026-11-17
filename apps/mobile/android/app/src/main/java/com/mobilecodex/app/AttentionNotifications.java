package com.mobilecodex.app;

import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/** Channels, ids and builders shared by the service and the action receiver. */
final class AttentionNotifications {
    static final String RUNNING = "attention_running";
    /** Pops up at the top of the screen and vibrates. A channel's importance can't be raised once created, so it has a new id. */
    static final String DONE = "attention_done_v2";
    /** Earlier builds' finished channel (default importance: status bar only); removed on start. */
    static final String LEGACY_DONE = "attention_done";
    static final String ACTION = "attention_action";
    static final String GATEWAY = "attention_gateway";
    static final int ONGOING_ID = 7100;
    static final int OFFLINE_ID = 7102;
    static final String GATEWAY_KEY = "gateway";
    static final String OPEN_ACTION = "com.mobilecodex.app.OPEN_ATTENTION";
    static final String EXTRA_KEY = "mobicodexAttentionKey";
    static final String EXTRA_TITLE = "mobicodexAttentionTitle";
    private static final int AMBER = 0xFFF59E0B;

    private AttentionNotifications() {}

    static void channels(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel running = new NotificationChannel(RUNNING, "任务进行中", NotificationManager.IMPORTANCE_LOW);
        running.setDescription("有任务在跑时保持和电脑的连接");
        running.setShowBadge(false);
        NotificationChannel done = new NotificationChannel(DONE, "任务完成", NotificationManager.IMPORTANCE_HIGH);
        done.setDescription("手机上发出的任务完成、失败或中断，在屏幕上方弹出并震动");
        done.enableVibration(true);
        // Someone who had turned the old channel off keeps it off; the sound stays the system default, as for approvals.
        NotificationChannel legacy = manager.getNotificationChannel(LEGACY_DONE);
        if (legacy != null && legacy.getImportance() == NotificationManager.IMPORTANCE_NONE && manager.getNotificationChannel(DONE) == null) {
            done.setImportance(NotificationManager.IMPORTANCE_NONE);
        }
        NotificationChannel action = new NotificationChannel(ACTION, "需要审批", NotificationManager.IMPORTANCE_HIGH);
        action.setDescription("Agent 等你批准或回答");
        NotificationChannel gateway = new NotificationChannel(GATEWAY, "电脑离线", NotificationManager.IMPORTANCE_HIGH);
        gateway.setDescription("等待任务结果期间，电脑网关连续两分钟不可达时提醒");
        gateway.enableVibration(true);
        manager.createNotificationChannel(running);
        manager.createNotificationChannel(done);
        manager.createNotificationChannel(action);
        manager.createNotificationChannel(gateway);
        if (legacy != null) manager.deleteNotificationChannel(LEGACY_DONE);
    }

    static int turnId(String key) { return ("turn|" + key).hashCode(); }

    static int requestId(String key, String request) { return ("request|" + key + "|" + request).hashCode(); }

    static PendingIntent open(Context context, String key, String title) {
        Intent intent = new Intent(context, MainActivity.class).setAction(OPEN_ACTION)
            .putExtra(EXTRA_KEY, key).putExtra(EXTRA_TITLE, title)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, ("open|" + key).hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static NotificationCompat.Builder builder(Context context, String channel) {
        return new NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_mobicodex)
            .setColor(AMBER)
            .setOnlyAlertOnce(true);
    }

    /** Lock screens show only that something needs the user, never commands or file names. */
    static NotificationCompat.Builder privately(Context context, NotificationCompat.Builder builder, String channel) {
        return builder.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(builder(context, channel).setContentTitle("MobiCodex").setContentText("有任务需要你查看").build());
    }

    @SuppressLint("MissingPermission") // Checked: areNotificationsEnabled() covers the Android 13 runtime permission.
    static void post(Context context, int id, NotificationCompat.Builder builder) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (manager.areNotificationsEnabled()) manager.notify(id, builder.build());
    }

    static void cancel(Context context, int id) { NotificationManagerCompat.from(context).cancel(id); }

    /** Replaces an approval notification with the outcome of its button. */
    static void outcome(Context context, int id, String key, String title, String text) {
        post(context, id, privately(context, builder(context, ACTION).setContentTitle(title).setContentText(text)
            .setContentIntent(open(context, key, title)).setAutoCancel(true).setTimeoutAfter(60_000), ACTION));
    }
}
