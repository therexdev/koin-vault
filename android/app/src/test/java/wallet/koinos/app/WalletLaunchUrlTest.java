package wallet.koinos.app;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class WalletLaunchUrlTest {
    private static final String BASE = "https://koinvault.app/android/";

    @Test public void purchaseAndArbitraryUrlsCannotReplaceTheWalletSurface() {
        String[] inputs = { null, "https://koinvault.app/?tab=convert",
            "https://koinvault.app/?source=pwa", "https://koinvault.app/api/fund/start",
            "https://koinvault.app/android/?tab=convert", "https://evil.example/?open=send",
            "http://koinvault.app/?open=send", "javascript:alert(1)", "not a uri",
            "https://koinvault.app:444/?open=send", "https://other@koinvault.app/?open=send" };
        for (String incoming : inputs) assertEquals(incoming, BASE, WalletLaunchUrl.resolve(BASE, incoming));
    }

    @Test public void onlySupportedWalletIntentsAreCarriedForward() {
        assertEquals(BASE + "?open=receive", WalletLaunchUrl.resolve(BASE, "https://koinvault.app/?open=receive"));
        assertEquals(BASE + "?open=send", WalletLaunchUrl.resolve(BASE, BASE + "?open=send&tab=convert"));
        assertEquals(BASE + "?tab=security", WalletLaunchUrl.resolve(BASE, BASE + "?tab=security"));
        assertEquals(BASE + "?open=send", WalletLaunchUrl.resolve(BASE, BASE + "?open=%73end"));
        assertEquals(BASE, WalletLaunchUrl.resolve(BASE, BASE + "?open=send%26tab%3Dconvert"));
    }
}
