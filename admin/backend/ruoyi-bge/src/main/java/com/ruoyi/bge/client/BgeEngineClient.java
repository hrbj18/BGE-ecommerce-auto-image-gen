package com.ruoyi.bge.client;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.bge.support.BgeProxyException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.multipart.MultipartHttpServletRequest;

/**
 * 调用固定回环地址上的 Node 生图引擎。
 */
@Component
public class BgeEngineClient
{
    private static final long MAX_JSON_BYTES = 2L * 1024 * 1024;
    private static final long MAX_IMAGE_BYTES = 50L * 1024 * 1024;
    private static final long MAX_MULTIPART_BYTES = 64L * 1024 * 1024;
    private static final Set<String> MULTIPART_TEXT_FIELDS = Set.of(
            "productName", "targetPlatform", "outputLanguage", "generationProfileId", "imageAspectRatioProfileId", "imageResolutionId", "briefFocus", "briefText",
            "expandBrief");
    private static final Set<String> MULTIPART_FILE_FIELDS = Set.of("referenceImages", "template");
    private static final Set<String> IMAGE_MEDIA_TYPES = Set.of(
            "image/jpeg", "image/png", "image/webp", "image/gif");

    private final ObjectMapper objectMapper;
    private final URI baseUri;
    private final String accessToken;
    private final HttpClient httpClient;
    private final Duration requestTimeout;
    private final Duration workbenchRequestTimeout;

    @Autowired
    public BgeEngineClient(ObjectMapper objectMapper,
            @Value("${BGE_ENGINE_BASE_URL:http://127.0.0.1:8787}") String baseUrl,
            @Value("${BGE_ENGINE_ACCESS_TOKEN:${LOCAL_WEB_ACCESS_TOKEN:}}") String accessToken,
            @Value("${BGE_ENGINE_WRITE_TIMEOUT_SECONDS:150}") long workbenchRequestTimeoutSeconds)
    {
        this(objectMapper, baseUrl, accessToken, HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(2))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build(), Duration.ofSeconds(8),
                Duration.ofSeconds(Math.max(30L, workbenchRequestTimeoutSeconds)));
    }

    public BgeEngineClient(ObjectMapper objectMapper, String baseUrl)
    {
        this(objectMapper, baseUrl, "");
    }

    public BgeEngineClient(ObjectMapper objectMapper, String baseUrl, String accessToken)
    {
        this(objectMapper, baseUrl, accessToken, HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(2))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build(), Duration.ofSeconds(8), Duration.ofSeconds(150));
    }

    BgeEngineClient(ObjectMapper objectMapper, String baseUrl, String accessToken,
            HttpClient httpClient, Duration requestTimeout)
    {
        this(objectMapper, baseUrl, accessToken, httpClient, requestTimeout, Duration.ofSeconds(30));
    }

    BgeEngineClient(ObjectMapper objectMapper, String baseUrl, String accessToken,
            HttpClient httpClient, Duration requestTimeout, Duration workbenchRequestTimeout)
    {
        this.objectMapper = objectMapper;
        this.baseUri = validateBaseUri(baseUrl);
        this.accessToken = normalizeAccessToken(accessToken);
        this.httpClient = httpClient;
        this.requestTimeout = requestTimeout;
        this.workbenchRequestTimeout = workbenchRequestTimeout;
    }

    public JsonNode getJson(String controlledPath)
    {
        HttpResponse<InputStream> response = send(controlledPath);
        try (InputStream body = response.body())
        {
            if (response.statusCode() == HttpStatus.NOT_FOUND.value())
            {
                throw BgeProxyException.notFound();
            }
            if (response.statusCode() != HttpStatus.OK.value())
            {
                throw BgeProxyException.invalidUpstream();
            }
            String mediaType = normalizedContentType(response);
            if (!"application/json".equals(mediaType))
            {
                throw BgeProxyException.invalidUpstream();
            }
            byte[] bytes = readBounded(body, response.headers().firstValueAsLong("Content-Length").orElse(-1L),
                    MAX_JSON_BYTES);
            JsonNode result = objectMapper.readTree(bytes);
            if (result == null || !result.isObject())
            {
                throw BgeProxyException.invalidUpstream();
            }
            return result;
        }
        catch (BgeProxyException exception)
        {
            throw exception;
        }
        catch (IOException exception)
        {
            throw BgeProxyException.invalidUpstream();
        }
    }

    public AssetResponse openAsset(String controlledPath)
    {
        HttpResponse<InputStream> response = send(controlledPath);
        if (response.statusCode() == HttpStatus.NOT_FOUND.value())
        {
            closeQuietly(response.body());
            throw BgeProxyException.notFound();
        }
        if (response.statusCode() != HttpStatus.OK.value())
        {
            closeQuietly(response.body());
            throw BgeProxyException.invalidUpstream();
        }
        String mediaType = normalizedContentType(response);
        long contentLength = response.headers().firstValueAsLong("Content-Length").orElse(-1L);
        if (!IMAGE_MEDIA_TYPES.contains(mediaType) || contentLength > MAX_IMAGE_BYTES)
        {
            closeQuietly(response.body());
            throw BgeProxyException.invalidUpstream();
        }
        return new AssetResponse(mediaType, contentLength,
                new BoundedInputStream(response.body(), MAX_IMAGE_BYTES));
    }

    /**
     * Forward one allowlisted workbench request to the local Node engine. The
     * caller supplies only a path checked against a business allowlist; this
     * client still enforces the fixed loopback origin and replaces every
     * browser credential with the internal engine credential.
     */
    public WorkbenchResponse forwardWorkbenchRequest(String method, String controlledPath,
            String contentType, String idempotencyKey, InputStream body)
    {
        String normalizedMethod = method == null ? "" : method.trim().toUpperCase(Locale.ROOT);
        if (!("GET".equals(normalizedMethod) || "POST".equals(normalizedMethod) || "DELETE".equals(normalizedMethod)))
        {
            throw BgeProxyException.invalidParameter();
        }
        URI target = resolveControlledPath(controlledPath);
        HttpRequest.Builder requestBuilder = HttpRequest.newBuilder(target)
                .timeout(workbenchRequestTimeout)
                .header("Accept", "application/json, application/zip, image/jpeg, image/png, image/webp, image/gif");
        if (isSafeHeaderValue(contentType, 512))
        {
            requestBuilder.header("Content-Type", contentType.trim());
        }
        if (isSafeHeaderValue(idempotencyKey, 256))
        {
            requestBuilder.header("X-Idempotency-Key", idempotencyKey.trim());
        }
        if (accessToken != null)
        {
            requestBuilder.header("Authorization", "Bearer " + accessToken);
        }
        HttpRequest.BodyPublisher publisher = "POST".equals(normalizedMethod)
                ? HttpRequest.BodyPublishers.ofInputStream(() -> body)
                : HttpRequest.BodyPublishers.noBody();
        try
        {
            HttpResponse<InputStream> response = httpClient.send(
                    requestBuilder.method(normalizedMethod, publisher).build(), HttpResponse.BodyHandlers.ofInputStream());
            return new WorkbenchResponse(response.statusCode(), normalizedContentType(response),
                    safeResponseHeader(response, "Content-Disposition", 512),
                    response.headers().firstValueAsLong("Content-Length").orElse(-1L), response.body());
        }
        catch (HttpTimeoutException exception)
        {
            throw BgeProxyException.unavailable();
        }
        catch (IOException exception)
        {
            throw BgeProxyException.unavailable();
        }
        catch (InterruptedException exception)
        {
            Thread.currentThread().interrupt();
            throw BgeProxyException.unavailable();
        }
    }

    /**
     * Performs a controlled workbench write and consumes only a bounded JSON
     * response. Portal controllers use this for accepted job identifiers; the
     * browser never receives the engine credential or raw upstream stream.
     */
    public JsonResponse forwardWorkbenchJson(String method, String controlledPath,
            String contentType, String idempotencyKey, InputStream body)
    {
        try (WorkbenchResponse response = forwardWorkbenchRequest(method, controlledPath,
                contentType, idempotencyKey, body))
        {
            if (!"application/json".equals(response.contentType()))
            {
                throw BgeProxyException.invalidUpstream();
            }
            byte[] bytes = readBounded(response.body(), response.contentLength(), MAX_JSON_BYTES);
            JsonNode payload = objectMapper.readTree(bytes);
            if (payload == null || !payload.isObject())
            {
                throw BgeProxyException.invalidUpstream();
            }
            return new JsonResponse(response.statusCode(), payload);
        }
        catch (BgeProxyException exception)
        {
            throw exception;
        }
        catch (IOException exception)
        {
            throw BgeProxyException.invalidUpstream();
        }
    }

    /**
     * Spring has already consumed multipart requests by the time a controller
     * runs. Rebuild only the known workbench fields so the Node engine receives
     * a complete multipart body instead of an empty servlet input stream.
     */
    public WorkbenchResponse forwardWorkbenchMultipartRequest(String method, String controlledPath,
            String idempotencyKey, MultipartHttpServletRequest request)
    {
        MultipartRequestBody payload = createMultipartRequestBody(request);
        return forwardWorkbenchRequest(method, controlledPath, payload.contentType(), idempotencyKey,
                new ByteArrayInputStream(payload.body()));
    }

    public JsonResponse forwardWorkbenchMultipartJson(String method, String controlledPath,
            String idempotencyKey, MultipartHttpServletRequest request)
    {
        try (WorkbenchResponse response = forwardWorkbenchMultipartRequest(method, controlledPath, idempotencyKey, request))
        {
            if (!"application/json".equals(response.contentType()))
            {
                throw BgeProxyException.invalidUpstream();
            }
            byte[] bytes = readBounded(response.body(), response.contentLength(), MAX_JSON_BYTES);
            JsonNode payload = objectMapper.readTree(bytes);
            if (payload == null || !payload.isObject())
            {
                throw BgeProxyException.invalidUpstream();
            }
            return new JsonResponse(response.statusCode(), payload);
        }
        catch (BgeProxyException exception)
        {
            throw exception;
        }
        catch (IOException exception)
        {
            throw BgeProxyException.invalidUpstream();
        }
    }

    private HttpResponse<InputStream> send(String controlledPath)
    {
        URI target = resolveControlledPath(controlledPath);
        HttpRequest.Builder requestBuilder = HttpRequest.newBuilder(target)
                .GET()
                .timeout(requestTimeout)
                .header("Accept", "application/json, image/jpeg, image/png, image/webp, image/gif");
        if (accessToken != null)
        {
            requestBuilder.header("Authorization", "Bearer " + accessToken);
        }
        HttpRequest request = requestBuilder.build();
        try
        {
            return httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());
        }
        catch (HttpTimeoutException exception)
        {
            throw BgeProxyException.unavailable();
        }
        catch (IOException exception)
        {
            throw BgeProxyException.unavailable();
        }
        catch (InterruptedException exception)
        {
            Thread.currentThread().interrupt();
            throw BgeProxyException.unavailable();
        }
    }

    private URI resolveControlledPath(String controlledPath)
    {
        if (controlledPath == null || !controlledPath.startsWith("/") || controlledPath.startsWith("//")
                || controlledPath.indexOf('\\') >= 0 || controlledPath.indexOf('\r') >= 0
                || controlledPath.indexOf('\n') >= 0 || controlledPath.indexOf('#') >= 0)
        {
            throw BgeProxyException.invalidParameter();
        }
        try
        {
            URI target = baseUri.resolve(controlledPath);
            if (!sameOrigin(baseUri, target))
            {
                throw BgeProxyException.invalidParameter();
            }
            return target;
        }
        catch (IllegalArgumentException exception)
        {
            throw BgeProxyException.invalidParameter();
        }
    }

    private static URI validateBaseUri(String raw)
    {
        try
        {
            URI uri = URI.create(raw == null ? "" : raw.trim());
            if (!uri.isAbsolute() || !"http".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || !(uri.getRawPath() == null || uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath())))
            {
                throw new IllegalArgumentException();
            }
            if (!isLiteralLoopbackHost(uri.getHost()))
            {
                throw new IllegalArgumentException();
            }
            int port = uri.getPort() == -1 ? 80 : uri.getPort();
            return URI.create("http://" + hostForUri(uri.getHost()) + ":" + port + "/");
        }
        catch (RuntimeException exception)
        {
            throw new IllegalArgumentException("BGE_ENGINE_BASE_URL must be a loopback HTTP origin.");
        }
    }

    private static boolean isLiteralLoopbackHost(String host)
    {
        String normalized = stripIpv6Brackets(host.toLowerCase(Locale.ROOT));
        if ("::1".equals(normalized)
                || "0:0:0:0:0:0:0:1".equals(normalized))
        {
            return true;
        }
        String[] parts = normalized.split("\\.", -1);
        if (parts.length != 4 || !"127".equals(parts[0]))
        {
            return false;
        }
        for (String part : parts)
        {
            if (part.isEmpty())
            {
                return false;
            }
            for (int index = 0; index < part.length(); index++)
            {
                char value = part.charAt(index);
                if (value < '0' || value > '9')
                {
                    return false;
                }
            }
            try
            {
                if (Integer.parseInt(part) > 255)
                {
                    return false;
                }
            }
            catch (NumberFormatException exception)
            {
                return false;
            }
        }
        return true;
    }

    private static String stripIpv6Brackets(String host)
    {
        if (host.length() >= 2 && host.charAt(0) == '[' && host.charAt(host.length() - 1) == ']')
        {
            return host.substring(1, host.length() - 1);
        }
        return host;
    }

    private static String hostForUri(String host)
    {
        String normalized = stripIpv6Brackets(host);
        return normalized.indexOf(':') >= 0 ? "[" + normalized + "]" : normalized;
    }

    private static String normalizeAccessToken(String raw)
    {
        if (raw == null || raw.isBlank())
        {
            return null;
        }
        String normalized = raw.strip();
        for (int index = 0; index < normalized.length(); index++)
        {
            char value = normalized.charAt(index);
            if (value < 0x20 || value == 0x7f)
            {
                throw new IllegalArgumentException("BGE engine access token is invalid.");
            }
        }
        return normalized;
    }

    private static boolean sameOrigin(URI expected, URI actual)
    {
        return expected.getScheme().equalsIgnoreCase(actual.getScheme())
                && expected.getHost().equalsIgnoreCase(actual.getHost())
                && effectivePort(expected) == effectivePort(actual);
    }

    private static int effectivePort(URI uri)
    {
        return uri.getPort() == -1 ? 80 : uri.getPort();
    }

    private static String normalizedContentType(HttpResponse<?> response)
    {
        return response.headers().firstValue("Content-Type")
                .map(value -> value.split(";", 2)[0].trim().toLowerCase(Locale.ROOT))
                .orElse("");
    }

    private static boolean isSafeHeaderValue(String value, int maximumLength)
    {
        if (value == null || value.isBlank() || value.length() > maximumLength)
        {
            return false;
        }
        for (int index = 0; index < value.length(); index++)
        {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7f)
            {
                return false;
            }
        }
        return true;
    }

    private static String safeResponseHeader(HttpResponse<?> response, String name, int maximumLength)
    {
        String value = response.headers().firstValue(name).orElse("");
        return isSafeHeaderValue(value, maximumLength) ? value.trim() : "";
    }

    private static byte[] readBounded(InputStream input, long announcedLength, long maximum) throws IOException
    {
        if (announcedLength > maximum)
        {
            throw new IOException("Response exceeds limit");
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        long total = 0;
        int read;
        while ((read = input.read(buffer)) != -1)
        {
            total += read;
            if (total > maximum)
            {
                throw new IOException("Response exceeds limit");
            }
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static MultipartRequestBody createMultipartRequestBody(MultipartHttpServletRequest request)
    {
        if (request == null)
        {
            throw BgeProxyException.invalidParameter();
        }
        String boundary = "----BgePortal" + UUID.randomUUID().toString().replace("-", "");
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try
        {
            for (var entry : request.getParameterMap().entrySet())
            {
                String name = entry.getKey();
                if (!MULTIPART_TEXT_FIELDS.contains(name))
                {
                    throw BgeProxyException.invalidParameter();
                }
                String[] values = entry.getValue();
                if (values == null)
                {
                    continue;
                }
                for (String value : values)
                {
                    appendTextPart(output, boundary, name, value == null ? "" : value);
                }
            }
            Iterator<String> fileNames = request.getFileNames();
            while (fileNames.hasNext())
            {
                String name = fileNames.next();
                if (!MULTIPART_FILE_FIELDS.contains(name))
                {
                    throw BgeProxyException.invalidParameter();
                }
                List<MultipartFile> files = request.getFiles(name);
                for (int index = 0; index < files.size(); index++)
                {
                    appendFilePart(output, boundary, name, files.get(index), index + 1);
                }
            }
            writeLimited(output, ("--" + boundary + "--\r\n").getBytes(StandardCharsets.US_ASCII));
            return new MultipartRequestBody("multipart/form-data; boundary=" + boundary, output.toByteArray());
        }
        catch (BgeProxyException exception)
        {
            throw exception;
        }
        catch (IOException exception)
        {
            throw BgeProxyException.invalidParameter();
        }
    }

    private static void appendTextPart(ByteArrayOutputStream output, String boundary, String name, String value)
            throws IOException
    {
        appendPartPrefix(output, boundary, name, "");
        writeLimited(output, "Content-Type: text/plain; charset=UTF-8\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
        writeLimited(output, value.getBytes(StandardCharsets.UTF_8));
        writeLimited(output, "\r\n".getBytes(StandardCharsets.US_ASCII));
    }

    private static void appendFilePart(ByteArrayOutputStream output, String boundary, String name,
            MultipartFile file, int index) throws IOException
    {
        if (file == null)
        {
            throw BgeProxyException.invalidParameter();
        }
        String filename = normalizedMultipartFilename(file.getOriginalFilename(), name, index);
        appendPartPrefix(output, boundary, name, filename);
        writeLimited(output, "Content-Type: application/octet-stream\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
        try (InputStream input = file.getInputStream())
        {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1)
            {
                writeLimited(output, buffer, 0, read);
            }
        }
        writeLimited(output, "\r\n".getBytes(StandardCharsets.US_ASCII));
    }

    private static void appendPartPrefix(ByteArrayOutputStream output, String boundary, String name, String filename)
            throws IOException
    {
        writeLimited(output, ("--" + boundary + "\r\n").getBytes(StandardCharsets.US_ASCII));
        String disposition = "Content-Disposition: form-data; name=\"" + name + "\"";
        if (!filename.isEmpty())
        {
            disposition += "; filename=\"upload\"; filename*=UTF-8''" + encodeRfc5987(filename);
        }
        writeLimited(output, (disposition + "\r\n").getBytes(StandardCharsets.US_ASCII));
    }

    private static String normalizedMultipartFilename(String raw, String fieldName, int index)
    {
        String value = raw == null ? "" : raw.replace('\\', '/');
        int slash = value.lastIndexOf('/');
        if (slash >= 0)
        {
            value = value.substring(slash + 1);
        }
        StringBuilder normalized = new StringBuilder();
        for (int position = 0; position < value.length() && normalized.length() < 180; position++)
        {
            char character = value.charAt(position);
            normalized.append(Character.isISOControl(character) ? '_' : character);
        }
        return normalized.isEmpty() ? fieldName + "-" + index : normalized.toString();
    }

    private static String encodeRfc5987(String value)
    {
        StringBuilder encoded = new StringBuilder();
        for (byte valueByte : value.getBytes(StandardCharsets.UTF_8))
        {
            int character = valueByte & 0xff;
            if ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
                    || (character >= '0' && character <= '9') || "!#$&+-.^_`|~".indexOf(character) >= 0)
            {
                encoded.append((char) character);
            }
            else
            {
                encoded.append('%');
                encoded.append(Character.toUpperCase(Character.forDigit((character >>> 4) & 0xf, 16)));
                encoded.append(Character.toUpperCase(Character.forDigit(character & 0xf, 16)));
            }
        }
        return encoded.toString();
    }

    private static void writeLimited(ByteArrayOutputStream output, byte[] bytes) throws IOException
    {
        writeLimited(output, bytes, 0, bytes.length);
    }

    private static void writeLimited(ByteArrayOutputStream output, byte[] bytes, int offset, int length) throws IOException
    {
        if (length < 0 || (long) output.size() + length > MAX_MULTIPART_BYTES)
        {
            throw new IOException("Multipart request exceeds limit");
        }
        output.write(bytes, offset, length);
    }

    private static void closeQuietly(InputStream input)
    {
        try
        {
            input.close();
        }
        catch (IOException ignored)
        {
        }
    }

    public record AssetResponse(String contentType, long contentLength, InputStream body) implements AutoCloseable
    {
        @Override
        public void close() throws IOException
        {
            body.close();
        }
    }

    public record WorkbenchResponse(int statusCode, String contentType, String contentDisposition,
            long contentLength, InputStream body) implements AutoCloseable
    {
        @Override
        public void close() throws IOException
        {
            body.close();
        }
    }

    public record JsonResponse(int statusCode, JsonNode body)
    {
    }

    private record MultipartRequestBody(String contentType, byte[] body)
    {
    }

    private static final class BoundedInputStream extends FilterInputStream
    {
        private long remaining;

        private BoundedInputStream(InputStream input, long maximum)
        {
            super(input);
            this.remaining = maximum;
        }

        @Override
        public int read() throws IOException
        {
            if (remaining == 0)
            {
                if (super.read() == -1)
                {
                    return -1;
                }
                throw new IOException("Response exceeds limit");
            }
            int value = super.read();
            if (value != -1)
            {
                remaining--;
            }
            return value;
        }

        @Override
        public int read(byte[] bytes, int offset, int length) throws IOException
        {
            if (remaining == 0)
            {
                if (super.read() == -1)
                {
                    return -1;
                }
                throw new IOException("Response exceeds limit");
            }
            int allowed = (int) Math.min(length, remaining);
            int read = super.read(bytes, offset, allowed);
            if (read > 0)
            {
                remaining -= read;
            }
            return read;
        }
    }
}
