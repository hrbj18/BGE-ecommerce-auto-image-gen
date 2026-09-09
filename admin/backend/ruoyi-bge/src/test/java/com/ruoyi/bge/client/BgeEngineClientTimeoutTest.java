package com.ruoyi.bge.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.bge.support.BgeProxyException;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

class BgeEngineClientTimeoutTest
{
    private static final String ACCESS_TOKEN = "test-timeout-access-token";

    @Test
    void returnsSafeUnavailableErrorWhenAuthenticatedUpstreamTimesOut() throws Exception
    {
        AtomicInteger requestCount = new AtomicInteger();
        AtomicInteger authorizedRequests = new AtomicInteger();
        HttpServer server = HttpServer.create(
                new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0);
        server.createContext("/", exchange -> {
            requestCount.incrementAndGet();
            if (("Bearer " + ACCESS_TOKEN).equals(
                    exchange.getRequestHeaders().getFirst("Authorization")))
            {
                authorizedRequests.incrementAndGet();
            }
            try
            {
                Thread.sleep(500);
            }
            catch (InterruptedException exception)
            {
                Thread.currentThread().interrupt();
            }
            exchange.close();
        });
        server.start();
        try
        {
            HttpClient httpClient = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofMillis(100))
                    .followRedirects(HttpClient.Redirect.NEVER)
                    .build();
            String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
            BgeEngineClient client = new BgeEngineClient(new ObjectMapper(), baseUrl,
                    ACCESS_TOKEN, httpClient, Duration.ofMillis(80));

            BgeProxyException failure = assertThrows(BgeProxyException.class,
                    () -> client.getJson("/health"));
            assertEquals(503, failure.getStatus().value());
            assertFalse(failure.getMessage().contains(ACCESS_TOKEN));
            assertTrue(requestCount.get() > 0);
            assertEquals(requestCount.get(), authorizedRequests.get());
        }
        finally
        {
            server.stop(0);
        }
    }
}
