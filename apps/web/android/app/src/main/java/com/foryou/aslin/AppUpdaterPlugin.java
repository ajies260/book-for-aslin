package com.foryou.aslin;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    @PluginMethod
    public void getAppVersion(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
            JSObject result = new JSObject();
            result.put("versionCode", code);
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not read the installed app version.", error);
        }
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        String downloadUrl = call.getString("url");
        String expectedSha256 = call.getString("sha256", "").toLowerCase(Locale.ROOT);
        String apiHost = call.getString("apiHost", "");
        Uri parsed = downloadUrl == null ? null : Uri.parse(downloadUrl);
        if (parsed == null || !("http".equals(parsed.getScheme()) || "https".equals(parsed.getScheme()))
                || !"/api/app/update.apk".equals(parsed.getPath())
                || apiHost.isEmpty() || !apiHost.equals(parsed.getAuthority())
                || !expectedSha256.matches("[a-f0-9]{64}")) {
            call.reject("The update address is invalid.");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(settings);
            JSObject result = new JSObject();
            result.put("permissionRequired", true);
            call.resolve(result);
            return;
        }

        new Thread(() -> downloadAndLaunch(call, downloadUrl, expectedSha256)).start();
    }

    private void downloadAndLaunch(PluginCall call, String downloadUrl, String expectedSha256) {
        File apk = null;
        HttpURLConnection connection = null;
        try {
            URL url = new URL(downloadUrl);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(90000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) throw new IllegalStateException("APK server returned HTTP " + status + ".");
            int length = connection.getContentLength();
            if (length <= 0 || length > 150 * 1024 * 1024) throw new IllegalStateException("The update package size is invalid.");

            File directory = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (directory == null) throw new IllegalStateException("Phone storage is unavailable.");
            apk = new File(directory, "aslin-for-you-update.apk");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(apk)) {
                byte[] buffer = new byte[32 * 1024];
                int read;
                long total = 0;
                while ((read = input.read(buffer)) != -1) {
                    total += read;
                    if (total > 150L * 1024L * 1024L) throw new IllegalStateException("The update package is too large.");
                    digest.update(buffer, 0, read);
                    output.write(buffer, 0, read);
                }
                output.getFD().sync();
            }
            StringBuilder actualHash = new StringBuilder();
            for (byte value : digest.digest()) actualHash.append(String.format(Locale.ROOT, "%02x", value & 0xff));
            if (!expectedSha256.equals(actualHash.toString())) throw new IllegalStateException("The downloaded update did not pass its integrity check.");

            final File downloadedApk = apk;
            Uri apkUri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", downloadedApk);
            Intent install = new Intent(Intent.ACTION_INSTALL_PACKAGE);
            install.setDataAndType(apkUri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            install.putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true);
            getActivity().runOnUiThread(() -> {
                try {
                    getActivity().startActivity(install);
                    JSObject result = new JSObject();
                    result.put("permissionRequired", false);
                    call.resolve(result);
                } catch (Exception error) {
                    downloadedApk.delete();
                    call.reject("Android could not open the installer.", error);
                }
            });
        } catch (Exception error) {
            if (apk != null) apk.delete();
            call.reject(error.getMessage() == null ? "The app update could not be downloaded." : error.getMessage(), error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
