package com.mobilecodex.app;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * F1: while the phone has work running on the computer, keeps one event stream to the gateway's
 * /api/attention/events and turns "finished" and "needs you" into notifications. It stops itself
 * when nothing is running or waiting, so there is no permanent notification.
 */
public class AttentionService extends Service {
    static final String START = "com.mobilecodex.app.attention.START";
    static final String STOP = "com.mobilecodex.app.attention.STOP";
    private static final long GRACE_MS = 90_000;
    private static final long IDLE_MS = 30_000;
    private static final int REMEMBERED_TURNS = 60;
    private static final long OFFLINE_GIVE_UP_MS = 10 * 60_000;
    private static final long STATUS_CHECK_MS = 10_000;
    private static volatile AttentionService current;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, JSONObject> items = new LinkedHashMap<>();
    private final Map<String, Set<String>> shownRequests = new HashMap<>();
    private final Runnable idleCheck = this::sync;
    private volatile boolean stopping;
    private volatile HttpURLConnection connection;
    private Thread worker;
    private long startedAt;
    private long idleSince;
    private long lastContact;
    private boolean connected;
    private boolean connectionFailed;
    private boolean phoneNetwork = true;
    private volatile int generation;
    private final GatewayOfflineState offline = new GatewayOfflineState();

    static void start(Context context) {
        ContextCompat.startForegroundService(context, new Intent(context, AttentionService.class).setAction(START));
    }

    static void stop() {
        AttentionService service = current;
        if (service != null) service.main.post(service::shutdown);
    }

    /** New endpoint or token: drop the stream; the worker reconnects with the new values. */
    static void reconnect() {
        AttentionService service = current;
        if (service != null) {
            service.generation++;
            service.dropConnection();
            service.main.post(() -> {
                service.offline.reset();
                AttentionNotifications.cancel(service, AttentionNotifications.OFFLINE_ID);
                service.connected = false;
                service.connectionFailed = false;
                service.lastContact = SystemClock.elapsedRealtime();
                service.sync();
            });
        }
    }

    static void settingsChanged() {
        AttentionService service = current;
        if (service != null) service.main.post(service::sync);
    }

    static boolean running() { return current != null; }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        AttentionNotifications.channels(this);
        // startForegroundService() requires startForeground() even when we are about to stop.
        Notification ongoing = ongoing("正在连接电脑…");
        if (Build.VERSION.SDK_INT >= 34) {
            ServiceCompat.startForeground(this, AttentionNotifications.ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(AttentionNotifications.ONGOING_ID, ongoing);
        }
        if ((intent != null && STOP.equals(intent.getAction())) || !AttentionConfig.ready()) {
            shutdown();
            return START_NOT_STICKY;
        }
        current = this;
        if (worker == null || !worker.isAlive()) {
            stopping = false;
            startedAt = SystemClock.elapsedRealtime();
            lastContact = startedAt;
            idleSince = 0;
            offline.reset();
            AttentionNotifications.cancel(this, AttentionNotifications.OFFLINE_ID);
            worker = new Thread(this::loop, "mobicodex-attention");
            worker.start();
            main.post(idleCheck);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        stopping = true;
        dropConnection();
        main.removeCallbacksAndMessages(null);
        offline.reset();
        AttentionNotifications.cancel(this, AttentionNotifications.OFFLINE_ID);
        if (current == this) current = null;
        super.onDestroy();
    }

    private void shutdown() {
        stopping = true;
        dropConnection();
        main.removeCallbacks(idleCheck);
        offline.reset();
        AttentionNotifications.cancel(this, AttentionNotifications.OFFLINE_ID);
        if (current == this) current = null;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void dropConnection() {
        HttpURLConnection value = connection;
        if (value != null) value.disconnect();
    }

    private void loop() {
        long backoff = 1_000;
        while (!stopping) {
            int streamGeneration = generation;
            try {
                stream(streamGeneration);
                backoff = 1_000;
            } catch (Unauthorized error) {
                if (streamGeneration == generation) {
                    // Authentication has its own re-pairing path; never label it a gateway outage.
                    main.post(() -> { if (streamGeneration == generation) shutdown(); });
                }
            } catch (IOException | JSONException | RuntimeException error) {
                // Network change, gateway restart or sleep: retry below.
            }
            if (stopping) return;
            main.post(() -> { if (streamGeneration == generation) { connected = false; connectionFailed = true; sync(); } });
            SystemClock.sleep(backoff);
            backoff = Math.min(backoff * 2, 30_000);
        }
    }

    private void stream(int streamGeneration) throws IOException, JSONException {
        HttpURLConnection http = (HttpURLConnection) new URL(AttentionConfig.url("/api/attention/events")).openConnection();
        connection = http;
        try {
            http.setRequestProperty("Authorization", "Bearer " + AttentionConfig.token);
            http.setRequestProperty("Accept", "text/event-stream");
            http.setConnectTimeout(15_000);
            http.setReadTimeout(45_000); // The gateway pings every 15 s.
            int code = http.getResponseCode();
            if (code == 401 || code == 403) throw new Unauthorized();
            if (code != 200) throw new IOException("attention stream " + code);
            main.post(() -> contact(streamGeneration));
            BufferedReader reader = new BufferedReader(new InputStreamReader(http.getInputStream(), StandardCharsets.UTF_8));
            String event = null, line;
            StringBuilder data = new StringBuilder();
            while (!stopping && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (event != null && data.length() > 0) dispatch(event, data.toString(), streamGeneration);
                    event = null;
                    data.setLength(0);
                } else if (line.startsWith("event:")) {
                    event = line.substring(6).trim();
                } else if (line.startsWith("data:")) {
                    if (data.length() > 0) data.append('\n');
                    data.append(line.substring(5).trim());
                }
            }
        } finally {
            connection = null;
            http.disconnect();
        }
    }

    private void contact(int streamGeneration) {
        if (stopping || streamGeneration != generation) return;
        connected = true;
        connectionFailed = false;
        lastContact = SystemClock.elapsedRealtime();
        offline.contact(System.currentTimeMillis());
        sync();
    }

    private void dispatch(String event, String data, int streamGeneration) throws JSONException {
        if ("ping".equals(event)) { main.post(() -> contact(streamGeneration)); return; }
        JSONObject value = new JSONObject(data);
        main.post(() -> {
            if (stopping || streamGeneration != generation) return;
            connected = true;
            connectionFailed = false;
            lastContact = SystemClock.elapsedRealtime();
            offline.contact(System.currentTimeMillis());
            if ("snapshot".equals(event)) {
                items.clear();
                JSONArray list = value.optJSONArray("items");
                for (int i = 0; list != null && i < list.length(); i++) {
                    JSONObject item = list.optJSONObject(i);
                    if (item != null) items.put(item.optString("key"), item);
                }
            } else if ("item".equals(event)) {
                items.put(value.optString("key"), value);
            } else if ("removed".equals(event)) {
                items.remove(value.optString("key"));
            }
            sync();
        });
    }

    /** Main thread: notifications follow the latest items; then decide whether to keep running. */
    private void sync() {
        if (stopping) return;
        phoneNetwork = hasPhoneNetwork();
        if (!phoneNetwork) connected = false;
        GatewayOfflineState.Change change = offline.update(SystemClock.elapsedRealtime(), true, phoneNetwork, connected || !connectionFailed, false, AttentionConfig.offline);
        if (change == GatewayOfflineState.Change.SHOW) notifyOffline();
        else if (change == GatewayOfflineState.Change.CLEAR) AttentionNotifications.cancel(this, AttentionNotifications.OFFLINE_ID);
        boolean active = false;
        for (JSONObject item : items.values()) {
            notifyTurn(item);
            notifyRequests(item);
            active |= item.optBoolean("running") || (item.optJSONArray("requests") != null && item.optJSONArray("requests").length() > 0);
        }
        for (String key : new ArrayList<>(shownRequests.keySet())) {
            if (!items.containsKey(key)) cancelRequests(key, new HashSet<>());
        }
        refreshOngoing();
        long now = SystemClock.elapsedRealtime();
        main.removeCallbacks(idleCheck);
        if (!connected && now - lastContact >= OFFLINE_GIVE_UP_MS) { shutdown(); return; }
        if (active || !connected) { idleSince = 0; main.postDelayed(idleCheck, STATUS_CHECK_MS); return; }
        if (idleSince == 0) idleSince = now;
        if (now - startedAt >= GRACE_MS && now - idleSince >= IDLE_MS) { shutdown(); return; }
        main.postDelayed(idleCheck, Math.max(GRACE_MS - (now - startedAt), IDLE_MS - (now - idleSince)) + 500);
    }

    private boolean hasPhoneNetwork() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        NetworkCapabilities capabilities = manager == null ? null : manager.getNetworkCapabilities(manager.getActiveNetwork());
        // A validated system network rules out captive portals/no Internet. A working F1 stream
        // also proves a route, allowing local-only Wi-Fi without probing any public server.
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            && (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) || connected);
    }

    private void notifyOffline() {
        long last = offline.lastConnectedAt();
        String text = last > 0 ? "最后一次连上：" + DateFormat.getDateTimeInstance().format(new Date(last)) : "最后一次连上：本次通知服务启动后尚未连上";
        AttentionNotifications.post(this, AttentionNotifications.OFFLINE_ID,
            AttentionNotifications.builder(this, AttentionNotifications.GATEWAY)
                .setContentTitle("电脑网关离线").setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(AttentionNotifications.open(this, AttentionNotifications.GATEWAY_KEY, "电脑网关离线"))
                .setAutoCancel(true).setPriority(NotificationCompat.PRIORITY_HIGH)
                .setDefaults(NotificationCompat.DEFAULT_SOUND | NotificationCompat.DEFAULT_VIBRATE)
                .setCategory(NotificationCompat.CATEGORY_STATUS));
    }

    private void notifyTurn(JSONObject item) {
        JSONObject turn = item.optJSONObject("lastTurn");
        if (turn == null) return;
        String key = item.optString("key"), marker = key + "|" + turn.optString("turnId");
        SharedPreferences prefs = getSharedPreferences("MobiCodexAttention", MODE_PRIVATE);
        List<String> seen = new ArrayList<>();
        try {
            JSONArray stored = new JSONArray(prefs.getString("notifiedTurns", "[]"));
            for (int i = 0; i < stored.length(); i++) seen.add(stored.getString(i));
        } catch (JSONException ignored) {
            // Start over; at worst one completion is shown twice.
        }
        if (seen.contains(marker)) return;
        seen.add(marker);
        while (seen.size() > REMEMBERED_TURNS) seen.remove(0);
        prefs.edit().putString("notifiedTurns", new JSONArray(seen).toString()).apply();
        if (!AttentionConfig.finished || AttentionConfig.watching(key)) return;
        String status = turn.optString("status"), title = item.optString("title", "Codex 任务");
        JSONObject reason = turn.optJSONObject("reason");
        // A Codex channel out of quota: the app offers the other channels to continue on.
        boolean quota = !"completed".equals(status) && reason != null && "rate_limited".equals(reason.optString("code")) && !key.startsWith("agent:");
        String heading = quota ? "额度用完" : "completed".equals(status) ? "任务完成" : "interrupted".equals(status) ? "任务已中断" : "任务失败";
        String text = quota ? title + " · 点开换个渠道接着做"
            : "completed".equals(status) || reason == null || reason.optString("message").isEmpty() ? title : title + " · " + reason.optString("message");
        NotificationCompat.Builder builder = AttentionNotifications.builder(this, AttentionNotifications.DONE)
            .setContentTitle(heading).setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(AttentionNotifications.open(this, key, title)).setAutoCancel(true)
            // Android 7 and below pop up on priority plus sound or vibration; 8+ follow the channel.
            .setPriority(NotificationCompat.PRIORITY_HIGH).setDefaults(NotificationCompat.DEFAULT_SOUND | NotificationCompat.DEFAULT_VIBRATE)
            .setCategory(NotificationCompat.CATEGORY_STATUS);
        AttentionNotifications.post(this, AttentionNotifications.turnId(key), AttentionNotifications.privately(this, builder, AttentionNotifications.DONE));
    }

    private void notifyRequests(JSONObject item) {
        String key = item.optString("key"), title = item.optString("title", "Codex 任务");
        JSONArray requests = item.optJSONArray("requests");
        Set<String> pending = new HashSet<>(), shown = shownRequests.get(key);
        if (shown == null) { shown = new HashSet<>(); shownRequests.put(key, shown); }
        for (int i = 0; requests != null && i < requests.length(); i++) {
            JSONObject request = requests.optJSONObject(i);
            if (request == null) continue;
            String id = request.optString("id");
            pending.add(id);
            if (!shown.add(id) || !AttentionConfig.approvals || AttentionConfig.watching(key)) continue;
            postRequest(key, title, request);
        }
        cancelRequests(key, pending);
    }

    private void postRequest(String key, String title, JSONObject request) {
        String id = request.optString("id"), detail = request.optString("detail");
        JSONArray risks = request.optJSONArray("risks");
        boolean question = "question".equals(request.optString("kind"));
        String body = request.optString("title") + (detail.isEmpty() ? "" : "：" + detail);
        if (risks != null && risks.length() > 0) body += "\n" + risks.optString(0) + "，请打开 App 处理";
        int notificationId = AttentionNotifications.requestId(key, id);
        NotificationCompat.Builder builder = AttentionNotifications.builder(this, AttentionNotifications.ACTION)
            .setContentTitle((question ? "需要你回答 · " : "需要审批 · ") + title).setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(AttentionNotifications.open(this, key, title)).setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH).setCategory(NotificationCompat.CATEGORY_REMINDER);
        if (request.optBoolean("canAllow")) builder.addAction(0, "允许一次", action(key, id, "allow", notificationId, title));
        if (request.optBoolean("canDeny")) builder.addAction(0, "拒绝", action(key, id, "deny", notificationId, title));
        AttentionNotifications.post(this, notificationId, AttentionNotifications.privately(this, builder, AttentionNotifications.ACTION));
    }

    private PendingIntent action(String key, String request, String decision, int notificationId, String title) {
        Intent intent = new Intent(this, AttentionActionReceiver.class)
            .putExtra("key", key).putExtra("request", request).putExtra("decision", decision)
            .putExtra("notification", notificationId).putExtra("title", title);
        return PendingIntent.getBroadcast(this, (notificationId + "|" + decision).hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Answered elsewhere (in the app, on the computer) or gone: take the notification down. */
    private void cancelRequests(String key, Set<String> pending) {
        Set<String> shown = shownRequests.get(key);
        if (shown == null) return;
        for (String id : new ArrayList<>(shown)) {
            if (pending.contains(id)) continue;
            shown.remove(id);
            int notificationId = AttentionNotifications.requestId(key, id);
            // A button answer leaves its outcome up for a minute; anything else answered elsewhere goes away.
            if (!AttentionActionReceiver.consumeAnswered(notificationId)) AttentionNotifications.cancel(this, notificationId);
        }
        if (shown.isEmpty() && !items.containsKey(key)) shownRequests.remove(key);
    }

    private void refreshOngoing() {
        if (stopping) return;
        int runningCount = 0, waiting = 0;
        for (JSONObject item : items.values()) {
            if (item.optBoolean("running")) runningCount++;
            JSONArray requests = item.optJSONArray("requests");
            if (requests != null) waiting += requests.length();
        }
        String text = !phoneNetwork ? "手机没有网络" : !connected ? "正在连接电脑…" : waiting > 0 ? waiting + " 项等你处理" : runningCount > 0 ? runningCount + " 个任务进行中" : "任务已结束";
        AttentionNotifications.post(this, AttentionNotifications.ONGOING_ID, ongoingBuilder(text));
    }

    private Notification ongoing(String text) { return ongoingBuilder(text).build(); }

    private NotificationCompat.Builder ongoingBuilder(String text) {
        Intent launch = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return AttentionNotifications.builder(this, AttentionNotifications.RUNNING)
            .setContentTitle("MobiCodex 正在等任务结果").setContentText(text)
            .setOngoing(true).setSilent(true).setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW).setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(PendingIntent.getActivity(this, 7101, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    }

    private static final class Unauthorized extends IOException {
        private static final long serialVersionUID = 1L;
    }
}
