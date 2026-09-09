package com.ruoyi.bge;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.bge.client.BgeEngineClient;
import com.ruoyi.bge.client.BgeEngineClient.AssetResponse;
import com.ruoyi.bge.domain.BgeDtos.Output;
import com.ruoyi.bge.domain.BgeDtos.TaskDetail;
import com.ruoyi.bge.domain.BgeDtos.TaskList;
import com.ruoyi.bge.service.BgeReadService;
import com.ruoyi.bge.support.BgeProxyException;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

class BgeReadServiceTest
{
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void mapsFiltersAndSanitizesTaskAndOutputContracts() throws Exception
    {
        try (MockEngine engine = new MockEngine())
        {
            BgeReadService service = service(engine);
            TaskList tasks = service.tasks("测试", "running");
            assertEquals(1, tasks.tasks().size());
            assertEquals("task-1", tasks.activeJobId());
            assertEquals("generating-main", tasks.activePhase());
            assertFalse(tasks.tasks().get(0).message().contains("C:\\private"));
            assertFalse(tasks.tasks().get(0).message().contains("abc123"));

            TaskDetail detail = service.task("task-1");
            String serialized = mapper.writeValueAsString(detail);
            assertFalse(serialized.contains("rawBriefText"));
            assertFalse(serialized.contains("finalBriefText"));
            assertFalse(serialized.contains("submissionClient"));
            assertFalse(serialized.contains("materialDir"));
            assertFalse(serialized.contains("outputDir"));
            assertFalse(serialized.contains("generationRuleFile"));
            assertFalse(serialized.contains("secret prompt"));
            assertFalse(serialized.contains("10.0.0.8"));
            assertFalse(serialized.contains("evil.example"));
            assertEquals(1, detail.events().size());
            assertEquals("running", detail.events().get(0).type());
            assertEquals("portrait-main", detail.imageAspectRatioProfileId());

            Output output = service.output("out-1");
            assertEquals("/bge/outputs/out-1/assets/main/01%20hero.jpg",
                    output.files().main().get(0).url());
            assertEquals("/bge/outputs/out-1/assets/overview/5%E5%BC%A0%E4%B8%BB%E5%9B%BE%E6%80%BB%E8%A7%88.jpg",
                    output.files().mainOverview());
            assertFalse(mapper.writeValueAsString(output).contains("package.zip"));
            assertEquals(0, engine.nonGetRequests.get());
            assertEquals(engine.requestCount.get(), engine.authorizedRequests.get());
        }
    }

    @Test
    void streamsOnlyImagesFromTheControlledLoopbackOrigin() throws Exception
    {
        try (MockEngine engine = new MockEngine())
        {
            BgeReadService service = service(engine);
            try (AssetResponse response = service.asset("out-1", "main", "01 hero.jpg"))
            {
                assertEquals("image/jpeg", response.contentType());
                assertArrayEquals(MockEngine.IMAGE, response.body().readAllBytes());
            }
            assertEquals("/outputs/out-1/main/01 hero.jpg", engine.lastPath);
            assertThrows(BgeProxyException.class, () -> service.asset("out-1", "main", "not-image.txt"));
            assertThrows(BgeProxyException.class, () -> service.asset("..", "main", "01.jpg"));
            BgeProxyException wrongType = assertThrows(BgeProxyException.class,
                    () -> service.asset("out-1", "main", "wrong.jpg"));
            assertEquals(502, wrongType.getStatus().value());
            BgeProxyException tooBig = assertThrows(BgeProxyException.class,
                    () -> service.asset("out-1", "main", "too-big.jpg"));
            assertEquals(502, tooBig.getStatus().value());
            assertEquals(0, engine.nonGetRequests.get());
            assertEquals(engine.requestCount.get(), engine.authorizedRequests.get());
        }
    }

    @Test
    void usesFixedSafeFailuresForMissingMalformedAndUnavailableUpstream() throws Exception
    {
        try (MockEngine engine = new MockEngine())
        {
            BgeReadService service = service(engine);
            BgeProxyException missing = assertThrows(BgeProxyException.class, () -> service.task("missing"));
            assertEquals(404, missing.getStatus().value());
            assertFalse(missing.getMessage().contains(engine.baseUrl()));

            BgeProxyException malformed = assertThrows(BgeProxyException.class, () -> service.task("malformed"));
            assertEquals(502, malformed.getStatus().value());
            assertFalse(malformed.getMessage().contains("not-json"));
            assertEquals(engine.requestCount.get(), engine.authorizedRequests.get());
        }

        BgeEngineClient unavailable = new BgeEngineClient(mapper, "http://127.0.0.1:1", MockEngine.ACCESS_TOKEN);
        BgeProxyException failure = assertThrows(BgeProxyException.class,
                () -> new BgeReadService(unavailable).health());
        assertEquals(503, failure.getStatus().value());
        assertFalse(failure.getMessage().contains("127.0.0.1"));

        try (DisconnectEngine engine = new DisconnectEngine())
        {
            BgeProxyException disconnected = assertThrows(BgeProxyException.class,
                    () -> new BgeReadService(new BgeEngineClient(mapper, engine.baseUrl(), MockEngine.ACCESS_TOKEN)).health());
            assertEquals(503, disconnected.getStatus().value());
            assertTrue(engine.requestCount.get() > 0);
            assertEquals(engine.requestCount.get(), engine.authorizedRequests.get());
        }
    }

    @Test
    void refusesAnyConfiguredNonLoopbackOrigin()
    {
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> new BgeEngineClient(mapper, "http://192.0.2.10:8787"));
        assertTrue(failure.getMessage().contains("loopback"));
        assertThrows(IllegalArgumentException.class,
                () -> new BgeEngineClient(mapper, "https://127.0.0.1:8787"));
        assertThrows(IllegalArgumentException.class,
                () -> new BgeEngineClient(mapper, "http://user@127.0.0.1:8787"));
        assertThrows(IllegalArgumentException.class,
                () -> new BgeEngineClient(mapper, "http://127.0.0.1:8787/base"));
        assertThrows(IllegalArgumentException.class,
                () -> new BgeEngineClient(mapper, "http://127.0.0.1.nip.io:8787"));
        assertThrows(IllegalArgumentException.class,
                () -> new BgeEngineClient(mapper, "http://localhost:8787"));
        assertThrows(IllegalArgumentException.class,
                () -> new BgeEngineClient(mapper, "http://127.0.0.+1:8787"));
        assertThrows(IllegalArgumentException.class,
                () -> new BgeEngineClient(mapper, "http://127.0.0.256:8787"));
        assertThrows(IllegalArgumentException.class,
                () -> new BgeEngineClient(mapper, "http://127.0.0.1:8787", "unsafe\r\ntoken"));
        new BgeEngineClient(mapper, "http://127.255.10.9:8787");
        new BgeEngineClient(mapper, "http://[::1]:8787");
        new BgeEngineClient(mapper, "http://[0:0:0:0:0:0:0:1]:8787");
    }

    @Test
    void omitsAuthorizationHeaderWhenAccessTokenIsBlank() throws Exception
    {
        try (MockEngine engine = new MockEngine(""))
        {
            BgeReadService service = new BgeReadService(new BgeEngineClient(mapper, engine.baseUrl(), "  "));
            assertEquals("ok", service.health().status());
            assertEquals(1, engine.requestCount.get());
            assertEquals(1, engine.authorizedRequests.get());
        }
    }

    private BgeReadService service(MockEngine engine)
    {
        return new BgeReadService(new BgeEngineClient(mapper, engine.baseUrl(), MockEngine.ACCESS_TOKEN));
    }

    private static final class MockEngine implements AutoCloseable
    {
        private static final String ACCESS_TOKEN = "test-local-access-token";
        private static final byte[] IMAGE = new byte[] { 1, 2, 3, 4, 5 };

        private final HttpServer server;
        private final String expectedAuthorization;
        private final AtomicInteger nonGetRequests = new AtomicInteger();
        private final AtomicInteger requestCount = new AtomicInteger();
        private final AtomicInteger authorizedRequests = new AtomicInteger();
        private volatile String lastPath = "";

        private MockEngine() throws IOException
        {
            this(ACCESS_TOKEN);
        }

        private MockEngine(String accessToken) throws IOException
        {
            expectedAuthorization = accessToken.isBlank() ? null : "Bearer " + accessToken;
            server = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0);
            server.createContext("/", this::handle);
            server.start();
        }

        private String baseUrl()
        {
            return "http://127.0.0.1:" + server.getAddress().getPort();
        }

        private void handle(HttpExchange exchange) throws IOException
        {
            requestCount.incrementAndGet();
            if (java.util.Objects.equals(expectedAuthorization,
                    exchange.getRequestHeaders().getFirst("Authorization")))
            {
                authorizedRequests.incrementAndGet();
            }
            if (!"GET".equals(exchange.getRequestMethod()))
            {
                nonGetRequests.incrementAndGet();
            }
            lastPath = exchange.getRequestURI().getPath();
            switch (lastPath)
            {
                case "/health" -> json(exchange, 200, """
                        {"status":"ok","state":"ready","service":"local-web-api","accessMode":"off","port":8787,
                         "uptimeSeconds":40,"activeJobs":1,"activeJobId":"task-1","activePhase":"generating-main",
                         "acceptingJobs":false,"disk":{"ok":true,"availableGiB":120.5,"minimumGiB":10}}
                        """);
                case "/api/tasks" -> json(exchange, 200, taskListJson());
                case "/api/tasks/task-1" -> json(exchange, 200, taskDetailJson());
                case "/api/tasks/missing" -> json(exchange, 404, "{\"error\":\"private upstream detail\"}");
                case "/api/tasks/malformed" -> text(exchange, 200, "application/json", "not-json".getBytes(StandardCharsets.UTF_8));
                case "/api/outputs/out-1" -> json(exchange, 200, outputJson());
                case "/outputs/out-1/main/01 hero.jpg" -> text(exchange, 200, "image/jpeg", IMAGE);
                case "/outputs/out-1/main/wrong.jpg" -> text(exchange, 200, "text/plain", IMAGE);
                case "/outputs/out-1/main/too-big.jpg" -> oversized(exchange);
                default -> json(exchange, 404, "{\"error\":\"missing\"}");
            }
        }

        private static String taskListJson()
        {
            return "{\"tasks\":[" + taskOneJson() + ","
                    + "{\"id\":\"task-2\",\"taskId\":\"task-2\",\"productName\":\"另一商品\",\"status\":\"done\"}],"
                    + "\"activeJobId\":\"task-1\",\"activePhase\":\"generating-main\"}";
        }

        private static String taskOneJson()
        {
            return """
                    {"id":"task-1","taskId":"task-1","productName":"测试商品","outputId":"out-1",
                       "status":"running","message":"处理中 C:\\\\private\\\\work\\\\file token=abc123",
                       "progress":{"stage":"generating-main","message":"已完成 2/13","total":13,"completed":2,
                         "mainCompleted":2,"detailCompleted":0,"retries":0,"backpressureCount":0,"concurrency":3,
                         "qualityRetryTotal":0,"qualityRetryCompleted":0,"updatedAt":"2026-09-01T01:00:00Z"},
                       "timing":{"workflowStartedAt":"2026-09-01T01:00:00Z","firstPreviewAt":"","firstPreviewElapsedMs":0},
                       "createdAt":"2026-09-01T01:00:00Z","updatedAt":"2026-09-01T01:01:00Z",
                       "submittedAtLocal":"2026-09-01 09:00:00","referenceCount":2,"targetPlatform":"天猫",
                       "outputLanguage":"Chinese","suiteRatio":"主图 3:4 / 详情页 9:16","imageAspectRatioProfileId":"portrait-main",
                       "promptAvailable":true,"promptComplete":true,
                       "outputProductName":"测试商品","outputDisplayName":"测试商品","hasOutput":true,"eventCount":1,
                       "latestEvent":{"id":"e1","type":"running","message":"生成中","createdAt":"2026-09-01T01:01:00Z",
                         "detail":{"sourceAddress":"10.0.0.8"}},"rawBriefText":"secret prompt","log":"full log",
                       "submissionClient":{"address":"10.0.0.8"}}
                    """;
        }

        private static String taskDetailJson()
        {
            String task = taskOneJson().trim();
            return task.substring(0, task.length() - 1)
                    + ",\"events\":[{\"id\":\"e1\",\"type\":\"running\",\"message\":\"see https://evil.example/a token=abc123\",\"createdAt\":\"2026-09-01T01:01:00Z\",\"detail\":{\"sourceAddress\":\"10.0.0.8\"}}],"
                    + "\"output\":" + outputJson() + ",\"finalBriefText\":\"secret prompt\",\"log\":\"full log\"}";
        }

        private static String outputJson()
        {
            return """
                    {"id":"out-1","folderName":"out-1","productName":"测试商品","displayName":"测试商品",
                     "taskId":"task-1","submittedAt":"2026-09-01T01:00:00Z","submittedAtLocal":"2026-09-01 09:00:00",
                     "materialExists":true,"status":"生成中","errorMessage":"","updatedAt":"2026-09-01T01:01:00Z",
                     "materialDir":"D:\\\\private\\\\materials","outputDir":"D:\\\\private\\\\outputs","report":"full log",
                     "generationRuleFile":"D:\\\\private\\\\rule.md","files":{
                       "main":[{"name":"01 hero.jpg","url":"https://evil.example/secret.jpg"}],
                       "detail":[{"name":"01 detail.png","url":"/outputs/out-1/detail/01.png"}],
                       "mainOverview":"/outputs/out-1/5.jpg","detailOverview":"","longDetail":"","packageZip":"/outputs/out-1/package.zip"}}
                    """;
        }

        private static void json(HttpExchange exchange, int status, String body) throws IOException
        {
            text(exchange, status, "application/json; charset=UTF-8", body.getBytes(StandardCharsets.UTF_8));
        }

        private static void text(HttpExchange exchange, int status, String contentType, byte[] body) throws IOException
        {
            exchange.getResponseHeaders().set("Content-Type", contentType);
            exchange.sendResponseHeaders(status, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        }

        private static void oversized(HttpExchange exchange) throws IOException
        {
            exchange.getResponseHeaders().set("Content-Type", "image/jpeg");
            exchange.sendResponseHeaders(200, 51L * 1024 * 1024);
            exchange.close();
        }

        @Override
        public void close()
        {
            server.stop(0);
        }
    }

    private static final class DisconnectEngine implements AutoCloseable
    {
        private final HttpServer server;
        private final AtomicInteger requestCount = new AtomicInteger();
        private final AtomicInteger authorizedRequests = new AtomicInteger();

        private DisconnectEngine() throws IOException
        {
            server = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0);
            server.createContext("/", exchange -> {
                requestCount.incrementAndGet();
                if (("Bearer " + MockEngine.ACCESS_TOKEN).equals(
                        exchange.getRequestHeaders().getFirst("Authorization")))
                {
                    authorizedRequests.incrementAndGet();
                }
                exchange.close();
            });
            server.start();
        }

        private String baseUrl()
        {
            return "http://127.0.0.1:" + server.getAddress().getPort();
        }

        @Override
        public void close()
        {
            server.stop(0);
        }
    }
}
