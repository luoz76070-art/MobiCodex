package com.mobilecodex.app;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Log;
import android.widget.Toast;

import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URLConnection;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native intake only stages content; the page decides what to do with it. */
@CapacitorPlugin(name = "Intake")
public class IntakePlugin extends Plugin {
    private static final String SHORTCUT_ACTION = "com.mobilecodex.app.SHORTCUT";
    private static final String EXTRA_SHORTCUT = "mobicodexShortcut";
    private static final int MAX_IMAGES = 9;
    private static final long MAX_IMAGE_BYTES = 25L * 1024 * 1024;
    private static final long CACHE_AGE_MS = 24L * 60 * 60 * 1000;
    // Clear and copy share this queue, so a clear cannot remove an image mid-copy.
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        executor.execute(() -> {
            try { clearExpired(); }
            catch (IOException | RuntimeException ignored) { /* Retry on the next cleanup. */ }
        });
        handleIntent(getActivity().getIntent());
    }

    void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (SHORTCUT_ACTION.equals(action)) {
            JSObject payload = new JSObject();
            try {
                String target = intent.getStringExtra(EXTRA_SHORTCUT);
                if (!"new-task".equals(target) && !"voice".equals(target) && !"thread".equals(target)) return;
                payload.put("target", target);
                if ("thread".equals(target)) {
                    String key = intent.getStringExtra("key");
                    if (key == null || key.isEmpty()) return;
                    payload.put("key", key);
                    String title = intent.getStringExtra("title");
                    if (title != null) payload.put("title", title);
                }
            } catch (RuntimeException ignored) {
                return;
            } finally {
                consumeIntent(intent);
            }
            notifyListeners("shortcut", payload, true);
            return;
        }
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        String text;
        String subject;
        List<Uri> streams = new ArrayList<>();
        try {
            CharSequence sharedText = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            CharSequence sharedSubject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
            text = sharedText == null ? null : sharedText.toString();
            subject = sharedSubject == null ? null : sharedSubject.toString();
            if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                ArrayList<Uri> uris = readStreams(intent);
                if (uris != null) streams.addAll(uris);
            } else {
                Uri uri = readStream(intent);
                if (uri != null) streams.add(uri);
            }
        } catch (RuntimeException ignored) {
            return;
        } finally {
            // Capture extras before consuming; keep the URI grants until copying finishes.
            consumeIntent(intent);
        }
        executor.execute(() -> receiveShare(text, subject, streams));
    }

    @SuppressWarnings("deprecation")
    private static Uri readStream(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    @SuppressWarnings("deprecation")
    private static ArrayList<Uri> readStreams(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
        return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
    }

    private static void consumeIntent(Intent intent) {
        intent.setAction(Intent.ACTION_MAIN);
        intent.removeExtra(Intent.EXTRA_TEXT);
        intent.removeExtra(Intent.EXTRA_SUBJECT);
        intent.removeExtra(Intent.EXTRA_STREAM);
        intent.removeExtra(EXTRA_SHORTCUT);
        intent.removeExtra("key");
        intent.removeExtra("title");
        intent.setClipData(null);
    }

    private void receiveShare(String text, String subject, List<Uri> streams) {
        String id = UUID.randomUUID().toString();
        JSArray images = new JSArray();
        int skipped = 0;
        for (int index = 0; index < streams.size(); index++) {
            if (images.length() >= MAX_IMAGES) { skipped++; continue; }
            try {
                images.put(copyImage(streams.get(index), id, index));
            } catch (IOException | RuntimeException error) {
                // Type and message only: enough to tell a missing grant from a bad file, without the content.
                Log.w("MobiCodexIntake", "share image skipped: " + error.getClass().getSimpleName() + ": " + error.getMessage());
                skipped++;
            }
        }
        if (images.length() == 0 && (text == null || text.trim().isEmpty()) && (subject == null || subject.trim().isEmpty())) {
            // Failed copies may have left an empty directory.
            try { deleteTree(new File(shareRoot(), id)); }
            catch (IOException | RuntimeException ignored) { /* The age-based cleanup retries. */ }
            // Nothing usable arrived: say so instead of opening the app with no sheet.
            if (skipped > 0) bridge.executeOnMainThread(() -> Toast.makeText(getContext(), "没能读取分享的图片", Toast.LENGTH_SHORT).show());
            return;
        }
        JSObject payload = new JSObject();
        payload.put("id", id);
        payload.put("text", text == null ? JSONObject.NULL : text);
        payload.put("subject", subject == null ? JSONObject.NULL : subject);
        payload.put("images", images);
        payload.put("skipped", skipped);
        bridge.executeOnMainThread(() -> notifyListeners("share", payload, true));
    }

    private JSObject copyImage(Uri uri, String id, int index) throws IOException {
        // An exported activity must not let a sender read our private files via file://.
        if (uri == null || !ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) throw new IOException("Unsupported image URI");
        // Nor via our own FileProvider (a sender could name one of our files and have us stage it).
        String authority = uri.getAuthority();
        if (authority == null || authority.startsWith(getContext().getPackageName() + ".")) throw new IOException("Unsupported image URI");
        ContentResolver resolver = getContext().getContentResolver();
        String name = imageName(resolver, uri);
        String mimeType = resolver.getType(uri);
        // Some providers report no type; the file name is the next best hint.
        if (mimeType == null) mimeType = URLConnection.guessContentTypeFromName(name);
        if (mimeType == null || !mimeType.startsWith("image/")) throw new IOException("Unsupported image type");
        File directory = new File(shareRoot(), id);
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Share cache unavailable");
        // Each stream has its own destination even if the provider repeats display names.
        File destination = new File(directory, index + "-" + name);
        boolean complete = false;
        long size = 0;
        try {
            try (InputStream input = resolver.openInputStream(uri);
                 FileOutputStream output = new FileOutputStream(destination)) {
                if (input == null) throw new IOException("Image unavailable");
                byte[] buffer = new byte[16 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    // Enforce the actual streamed size, not untrusted provider metadata.
                    if (size + count > MAX_IMAGE_BYTES) throw new IOException("Image too large");
                    output.write(buffer, 0, count);
                    size += count;
                }
            }
            complete = true;
        } finally {
            if (!complete && !destination.delete() && destination.exists()) {
                // Do not leave a readable partial image if unlinking failed.
                try (FileOutputStream output = new FileOutputStream(destination)) { output.getChannel().truncate(0); }
            }
        }
        JSObject image = new JSObject();
        image.put("path", destination.getAbsolutePath());
        image.put("name", name);
        image.put("mimeType", mimeType);
        image.put("size", size);
        return image;
    }

    private static String imageName(ContentResolver resolver, Uri uri) {
        String name = null;
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (column >= 0) name = cursor.getString(column);
            }
        } catch (RuntimeException ignored) { /* Providers may not implement metadata queries. */ }
        if (name == null) name = "image";
        // At most 240 UTF-8 bytes, leaving room for the numeric prefix on Android filesystems.
        name = truncate(name.replaceAll("[\\\\/\\p{Cntrl}]", "_").trim(), 60);
        return name.isEmpty() || ".".equals(name) || "..".equals(name) ? "image" : name;
    }

    @PluginMethod
    public void setRecentThreads(PluginCall call) {
        JSArray threads = call.getArray("threads");
        if (threads == null) { call.reject("intake_threads_required"); return; }
        // Launcher shortcuts are not supported before Android 7.1.
        if (Build.VERSION.SDK_INT < 25) { call.resolve(); return; }
        try {
            int available = Math.max(0, ShortcutManagerCompat.getMaxShortcutCountPerActivity(getContext())
                - ShortcutManagerCompat.getShortcuts(getContext(), ShortcutManagerCompat.FLAG_MATCH_MANIFEST).size());
            List<ShortcutInfoCompat> shortcuts = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            for (int index = 0; index < Math.min(3, threads.length()) && shortcuts.size() < available; index++) {
                JSONObject thread = threads.optJSONObject(index);
                if (thread == null || !(thread.opt("key") instanceof String)) continue;
                String key = thread.optString("key");
                if (key.isEmpty() || !seen.add(key)) continue;
                String title = thread.opt("title") instanceof String ? thread.optString("title") : "";
                String label = title.trim();
                if (label.isEmpty()) label = getContext().getString(R.string.shortcut_thread);
                Intent intent = new Intent(getContext(), MainActivity.class)
                    .setAction(SHORTCUT_ACTION)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    .putExtra(EXTRA_SHORTCUT, "thread")
                    .putExtra("key", key)
                    .putExtra("title", title);
                shortcuts.add(new ShortcutInfoCompat.Builder(getContext(), "thread:" + key)
                    .setShortLabel(truncate(label, 24))
                    .setIcon(IconCompat.createWithResource(getContext(), R.drawable.ic_shortcut_thread))
                    .setIntent(intent)
                    .setRank(shortcuts.size())
                    .build());
            }
            if (ShortcutManagerCompat.setDynamicShortcuts(getContext(), shortcuts)) call.resolve();
            else call.reject("intake_shortcuts_unavailable");
        } catch (RuntimeException error) {
            call.reject("intake_shortcuts_unavailable");
        }
    }

    private static String truncate(String text, int maxCharacters) {
        int count = text.codePointCount(0, text.length());
        return count <= maxCharacters ? text : text.substring(0, text.offsetByCodePoints(0, maxCharacters));
    }

    @PluginMethod
    public void clear(PluginCall call) {
        String id = call.getString("id");
        if (id != null && !isShareId(id)) { call.reject("intake_invalid_id"); return; }
        executor.execute(() -> {
            try {
                if (id == null) clearExpired();
                else deleteTree(new File(shareRoot(), id));
                call.resolve();
            } catch (IOException | RuntimeException error) {
                call.reject("intake_clear_failed");
            }
        });
    }

    private File shareRoot() throws IOException {
        return new File(getContext().getCacheDir(), "share").getCanonicalFile();
    }

    private static boolean isShareId(String id) {
        return id.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    }

    private void clearExpired() throws IOException {
        File[] entries = shareRoot().listFiles();
        if (entries == null) return;
        long cutoff = System.currentTimeMillis() - CACHE_AGE_MS;
        for (File entry : entries) {
            if (isShareId(entry.getName()) && entry.lastModified() < cutoff) deleteTree(entry);
        }
    }

    private static void deleteTree(File file) throws IOException {
        if (!file.exists()) return;
        // Do not follow symbolic links during recursive deletion, even inside the cache.
        File expected = new File(file.getParentFile().getCanonicalFile(), file.getName());
        if (file.isDirectory() && file.getCanonicalFile().equals(expected)) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("Share cache unreadable");
            for (File child : children) deleteTree(child);
        }
        if (!file.delete() && file.exists()) throw new IOException("Share cache cleanup failed");
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdown();
        super.handleOnDestroy();
    }
}
