package com.ruoyi.bge.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.mock.web.MockMultipartHttpServletRequest;

class BgeEngineClientMultipartTest
{
    @Test
    void rebuildsSpringParsedMultipartBeforeForwardingToTheNodeEngine() throws Exception
    {
        AtomicReference<String> contentType = new AtomicReference<>("");
        AtomicReference<byte[]> requestBody = new AtomicReference<>(new byte[0]);
        HttpServer server = HttpServer.create(
                new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0);
        server.createContext("/api/brief-expansions", exchange -> {
            contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
            requestBody.set(exchange.getRequestBody().readAllBytes());
            try
            {
                Thread.sleep(80);
            }
            catch (InterruptedException exception)
            {
                Thread.currentThread().interrupt();
            }
            byte[] response = "{\"id\":\"brief-1\",\"status\":\"queued\"}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(202, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        try
        {
            MockMultipartHttpServletRequest request = new MockMultipartHttpServletRequest();
            request.addParameter("productName", "机械臂");
            request.addParameter("briefText", "结构稳定，支持编程控制");
            request.addParameter("imageResolutionId", "1k");
            request.addParameter("imageAspectRatioProfileId", "portrait-main");
            request.addFile(new MockMultipartFile("referenceImages", "robot.png", "image/png",
                    new byte[] { 1, 2, 3, 4 }));
            String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
            BgeEngineClient client = new BgeEngineClient(new ObjectMapper(), baseUrl,
                    "test-access-token", HttpClient.newHttpClient(), Duration.ofMillis(20),
                    Duration.ofMillis(500));

            BgeEngineClient.JsonResponse result = client.forwardWorkbenchMultipartJson("POST",
                    "/api/brief-expansions", "multipart-test", request);

            assertEquals(202, result.statusCode());
            assertEquals("brief-1", result.body().path("id").asText());
            assertTrue(contentType.get().startsWith("multipart/form-data; boundary=----BgePortal"));
            String wire = new String(requestBody.get(), StandardCharsets.UTF_8);
            assertTrue(wire.contains("name=\"productName\""));
            assertTrue(wire.contains("机械臂"));
            assertTrue(wire.contains("name=\"imageResolutionId\""));
            assertTrue(wire.contains("1k"));
            assertTrue(wire.contains("name=\"imageAspectRatioProfileId\""));
            assertTrue(wire.contains("portrait-main"));
            assertTrue(wire.contains("name=\"referenceImages\""));
            assertTrue(wire.contains("filename*=UTF-8''robot.png"));
        }
        finally
        {
            server.stop(0);
        }
    }
}
